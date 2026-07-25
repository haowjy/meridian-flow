/** Immutable-base conflict preparation for Manual Apply and auto-push trail projection. */
import {
  type AgentEditCodec,
  type BlockSnapshot,
  diffSnapshots,
  intersectLineageRanges,
  snapshotBlocks,
  toDocHandle,
  type UpdateJournal,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DraftApplyConflict } from "@meridian/contracts";
import { createCollabYDoc, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import {
  type BranchJournalRow,
  type PreparedPush,
  type PreparedPushCommit,
  type PushReceiptPayload,
  replacementScopesFromBranchRow,
} from "./branch-push-contracts.js";
import { buildReceipt } from "./branch-push-plan.js";
import {
  journalAttributionByChangedBlock,
  preparedTrailChanges,
} from "./branch-trail-projection.js";
import { partitionByBlockCoverage } from "./branch-update-attribution.js";
import type { RawTrailChange } from "./trail-read-kernel.js";

export type PushPreparationPhase = {
  branch: BranchSnapshot;
  rows: BranchJournalRow[];
  pushUpdate: Uint8Array;
  receipt: PushReceiptPayload;
  idempotencyKey: string;
  receiptId: string;
  rowBaselineStates: ReadonlyMap<number, Uint8Array>;
};

type PushPreparationInput = {
  journal: UpdateJournal;
  model: YProsemirrorDocumentModel;
  attributionCodec: AgentEditCodec;
};

export async function preparePushUnderLiveLock(
  input: PushPreparationInput,
  phase: PushPreparationPhase,
  lockCutUpdate: Uint8Array,
  receiptId = phase.receiptId,
): Promise<PreparedPush> {
  const lockCutDoc = createCollabYDoc({ gc: false });
  Y.applyUpdate(lockCutDoc, lockCutUpdate);
  const before = snapshotBlocks(toDocHandle(lockCutDoc), input.model, input.attributionCodec);
  const afterDoc = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(afterDoc, lockCutUpdate);
    Y.applyUpdate(afterDoc, phase.pushUpdate);
    const after = snapshotBlocks(toDocHandle(afterDoc), input.model, input.attributionCodec);
    const candidateEffects = diffSnapshots(before, after);
    const journal = await input.journal.read(phase.branch.documentId);
    const beforeByHash = new Map(before.map((block) => [block.hash, block]));
    const afterSnapshotByHash = new Map(after.map((block) => [block.hash, block]));
    const conflictEvidence = new Map<
      string,
      {
        row: BranchJournalRow;
        base: (typeof before)[number] | undefined;
        resurrection?: (typeof before)[number];
        enclosedInsertion?: (typeof before)[number];
        ambiguous?: boolean;
      }
    >();
    const resurrectionBodies = new Map<string, (typeof before)[number]>();
    const rowAssociatedEffects = new Set<string>();
    let protectedDeletionSeen = false;
    for (const row of phase.rows) {
      const baselineState = phase.rowBaselineStates.get(row.draftBaseUpdateSeq);
      if (!baselineState) throw new Error(`missing immutable draft base ${row.draftBaseUpdateSeq}`);
      const coverage = partitionByBlockCoverage({
        baselineState,
        upstreamState: lockCutUpdate,
        rows: journal.updates
          .filter((update) => update.seq > row.draftBaseUpdateSeq)
          .map((update) => ({
            id: update.seq,
            source: update.meta.origin.startsWith("human:") ? "writer" : "agent",
            actorTurnId: update.meta.actorTurnId,
            update: update.update,
          })),
        model: input.model,
        codec: input.attributionCodec,
      });
      const humanTouched = new Set(coverage.humanResidualHashes);
      for (const [hash, owner] of coverage.coverage) {
        if (owner.origin === "writer") humanTouched.add(hash);
      }
      for (const [hash, owner] of coverage.deletedCoverage) {
        if (owner.origin === "writer") humanTouched.add(hash);
      }
      for (const hash of coverage.humanDeletedHashes) humanTouched.add(hash);

      const rowAfterDoc = createCollabYDoc({ gc: false });
      Y.applyUpdate(rowAfterDoc, lockCutUpdate);
      Y.applyUpdate(rowAfterDoc, row.updateData);
      const rowAfter = snapshotBlocks(
        toDocHandle(rowAfterDoc),
        input.model,
        input.attributionCodec,
      );
      rowAfterDoc.destroy();
      const rowEffects = diffSnapshots(before, rowAfter);
      for (const hash of [...rowEffects.changed, ...rowEffects.deleted, ...rowEffects.inserted]) {
        rowAssociatedEffects.add(hash);
      }
      for (const hash of [...rowEffects.changed, ...rowEffects.deleted]) {
        if (
          humanTouched.has(hash) &&
          (candidateEffects.changed.has(hash) || candidateEffects.deleted.has(hash))
        ) {
          conflictEvidence.set(hash, { row, base: undefined });
        }
      }

      const baselineDoc = createCollabYDoc({ gc: false });
      Y.applyUpdate(baselineDoc, baselineState);
      const baselineBlocks = snapshotBlocks(
        toDocHandle(baselineDoc),
        input.model,
        input.attributionCodec,
      );
      baselineDoc.destroy();
      const baselineByHash = new Map(baselineBlocks.map((block) => [block.hash, block]));
      const persistedReplacementScopes = replacementScopesFromBranchRow(row);
      const replacedBaselineHashScopes = persistedReplacementScopes.complete
        ? persistedReplacementScopes.scopes.map(
            (scope) =>
              new Set(
                baselineBlocks
                  .filter(
                    (block) =>
                      block.lineage && intersectLineageRanges(scope, block.lineage).length > 0,
                  )
                  .map((block) => block.hash),
              ),
          )
        : [replacementHashesFromRowUpdate(baselineState, baselineBlocks, row, input)];
      const baselineIdentities = new Set(
        baselineBlocks.flatMap((block) => {
          const identity = blockIdentity(block);
          return identity ? [identity] : [];
        }),
      );
      const writerInsertedHashes = new Set(
        [...coverage.coverage]
          .filter(([hash, owner]) => {
            const identity = blockIdentity(beforeByHash.get(hash));
            return owner.origin === "writer" && !!identity && !baselineIdentities.has(identity);
          })
          .map(([hash]) => hash),
      );
      for (const hash of coverage.humanResidualHashes) {
        const identity = blockIdentity(beforeByHash.get(hash));
        if (identity && !baselineIdentities.has(identity)) {
          writerInsertedHashes.add(hash);
        }
      }
      for (const hash of writerInsertedHashes) {
        const inserted = beforeByHash.get(hash);
        if (
          inserted &&
          replacedBaselineHashScopes.some((replacedBaselineHashes) =>
            replacedScopeEnclosesInsertion({
              baseline: baselineBlocks,
              live: before,
              replacedBaselineHashes,
              insertedHash: hash,
            }),
          )
        ) {
          conflictEvidence.set(hash, {
            row,
            base: undefined,
            enclosedInsertion: inserted,
          });
        }
      }
      for (const [hash, evidence] of conflictEvidence) {
        if (evidence.row.id === row.id) evidence.base = baselineByHash.get(hash);
      }
      const protectedDeletedHashes = new Set(coverage.humanDeletedHashes);
      for (const [hash, owner] of coverage.deletedCoverage) {
        if (owner.origin === "writer" && !beforeByHash.has(hash)) protectedDeletedHashes.add(hash);
      }
      const deletedBaselineBlocks = [...protectedDeletedHashes].flatMap((hash) => {
        const block = baselineByHash.get(hash);
        return block ? [block] : [];
      });
      if (deletedBaselineBlocks.length > 0) protectedDeletionSeen = true;
      for (const insertedHash of rowEffects.inserted) {
        if (!candidateEffects.inserted.has(insertedHash)) continue;
        const inserted = afterSnapshotByHash.get(insertedHash);
        if (!inserted) continue;
        const deletedBase = deletedBaselineBlocks.find(
          (block) => block.clientID === inserted.clientID && block.clock === inserted.clock,
        );
        if (deletedBase) {
          resurrectionBodies.set(insertedHash, deletedBase);
          conflictEvidence.set(insertedHash, {
            row,
            base: deletedBase,
            resurrection: deletedBase,
          });
        } else if (deletedBaselineBlocks.length > 0) {
          // The row inserts after a protected canonical deletion, but Yjs ancestry
          // cannot associate it with exactly one deleted block. Refuse/report the
          // ambiguity without inventing a resurrection claim from equal bytes.
          conflictEvidence.set(insertedHash, { row, base: undefined, ambiguous: true });
        }
      }
    }
    if (protectedDeletionSeen) {
      const fallbackRow = [...phase.rows].sort(
        (left, right) => left.draftBaseUpdateSeq - right.draftBaseUpdateSeq,
      )[0];
      if (fallbackRow) {
        for (const insertedHash of candidateEffects.inserted) {
          if (!rowAssociatedEffects.has(insertedHash)) {
            conflictEvidence.set(insertedHash, {
              row: fallbackRow,
              base: undefined,
              ambiguous: true,
            });
          }
        }
      }
    }
    const allConflicts = [...conflictEvidence.keys()].sort();
    const attribution = journalAttributionByChangedBlock({
      liveDoc: lockCutDoc,
      rows: phase.rows,
      model: input.model,
    });
    const conflicts: DraftApplyConflict[] = allConflicts.map((blockId) => {
      const evidence = conflictEvidence.get(blockId) as NonNullable<
        ReturnType<typeof conflictEvidence.get>
      >;
      const resurrection = evidence.resurrection;
      const enclosedInsertion = evidence.enclosedInsertion;
      const base = resurrection ?? evidence.base;
      const live = beforeByHash.get(blockId);
      const proposed = afterSnapshotByHash.get(blockId);
      const effect = resurrection
        ? "resurrection"
        : enclosedInsertion
          ? "enclosed_insertion"
          : proposed
            ? "overwrite"
            : "delete";
      return {
        blockId,
        journalIds: [evidence.row.id],
        draftBaseUpdateSeq: evidence.row.draftBaseUpdateSeq,
        effect,
        evidence: resurrection
          ? "human_live_deletion"
          : enclosedInsertion
            ? "human_live_insertion"
            : evidence.ambiguous
              ? "ambiguous_protected_divergence"
              : "human_live_change",
        captured: {
          base: base?.serialized ?? null,
          live: live?.serialized ?? null,
          proposed: proposed?.serialized ?? null,
        },
        why: resurrection
          ? "Apply would make content deleted by the writer after this draft began visible again."
          : enclosedInsertion
            ? "Apply would rewrite the scope where the writer inserted this content after the draft began."
            : evidence.ambiguous
              ? "Apply inserts content after a protected writer deletion, but canonical ancestry cannot prove which block it covers."
              : "Apply would delete or overwrite live content changed by the writer after this draft began.",
      };
    });
    const blindConflictedBlocks = conflicts
      .filter((conflict) => conflict.effect !== "enclosed_insertion")
      .map((conflict) => conflict.blockId)
      .sort();
    const conflictedBlocks = allConflicts;
    const afterBlocks = input.model.getBlocks(toDocHandle(afterDoc));
    const afterXmlBlocks = afterDoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME).toArray();
    const afterById = new Map(
      afterBlocks.flatMap((block, index) => {
        const xml = afterXmlBlocks[index];
        return xml instanceof Y.XmlElement ? [[input.model.getBlockId(block), xml] as const] : [];
      }),
    );
    const afterIds = new Set(after.map((block) => block.hash));
    const beforeBodies = new Map(before.map((block) => [block.hash, block.serialized]));
    for (const [hash, block] of resurrectionBodies) beforeBodies.set(hash, block.serialized);
    const blockIdentities = new Map(
      [...before, ...after].map(
        (block) =>
          [
            block.hash,
            {
              documentId: phase.branch.documentId,
              clientID: block.clientID,
              clock: block.clock,
            },
          ] as const,
      ),
    );
    const changes: RawTrailChange[] = preparedTrailChanges({
      receipt: buildReceipt({
        model: input.model,
        documentId: phase.branch.documentId,
        branch: phase.branch,
        pushKind: phase.receipt.pushKind,
        beforeDoc: lockCutDoc,
        afterDoc,
      }),
      receiptId,
      ownersByBlock: attribution.ownersByBlock,
      operations: attribution.operations.map((operation) => ({
        ...operation,
        insertedBlocks: operation.insertedBlockIds.flatMap((blockId) => {
          const block = afterById.get(blockId);
          return block ? [{ blockId, block }] : [];
        }),
      })),
      conflictedBlocks: blindConflictedBlocks,
      before,
      blockIdentities,
      beforeBodies,
      afterIds,
      afterById,
      afterDoc,
      beforeContentRef: journal.updates.at(-1)?.seq ?? null,
      resurrectionBodies: new Map(
        [...resurrectionBodies].map(([hash, block]) => [hash, block.serialized]),
      ),
    });
    return {
      conflictedBlocks,
      blindConflictedBlocks,
      conflicts,
      beforeContentRef: journal.updates.at(-1)?.seq ?? null,
      trailChanges: changes,
      lockCutUpdate,
      prepared: {
        branch: phase.branch,
        journalRows: phase.rows,
        pushUpdate: phase.pushUpdate,
        receiptPayload: buildReceipt({
          model: input.model,
          documentId: phase.branch.documentId,
          branch: phase.branch,
          pushKind: phase.receipt.pushKind,
          beforeDoc: lockCutDoc,
          afterDoc,
        }),
        idempotencyKey: phase.idempotencyKey,
        receiptId,
      } satisfies Omit<PreparedPushCommit, "pushedByUserId" | "trail" | "pendingLiveSettlement">,
    };
  } finally {
    afterDoc.destroy();
    lockCutDoc.destroy();
  }
}

function replacementHashesFromRowUpdate(
  baselineState: Uint8Array,
  baselineBlocks: readonly BlockSnapshot[],
  row: BranchJournalRow,
  input: PushPreparationInput,
): Set<string> {
  const afterDoc = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(afterDoc, baselineState);
    Y.applyUpdate(afterDoc, row.updateData);
    const effects = diffSnapshots(
      baselineBlocks,
      snapshotBlocks(toDocHandle(afterDoc), input.model, input.attributionCodec),
    );
    return new Set([...effects.changed, ...effects.deleted]);
  } finally {
    afterDoc.destroy();
  }
}

function replacedScopeEnclosesInsertion(input: {
  baseline: readonly BlockSnapshot[];
  live: readonly BlockSnapshot[];
  replacedBaselineHashes: ReadonlySet<string>;
  insertedHash: string;
}): boolean {
  if (input.baseline.length === 0 || input.replacedBaselineHashes.size === 0) return false;
  if (input.baseline.every((block) => input.replacedBaselineHashes.has(block.hash))) {
    return true;
  }

  const insertedIndex = input.live.findIndex((block) => block.hash === input.insertedHash);
  if (insertedIndex < 0) return false;
  const baselineIndexByIdentity = new Map(
    input.baseline.flatMap((block, index) => {
      const identity = blockIdentity(block);
      return identity ? [[identity, index] as const] : [];
    }),
  );
  let left: number | undefined;
  for (let index = insertedIndex - 1; index >= 0; index -= 1) {
    const identity = blockIdentity(input.live[index]);
    const baselineIndex = identity ? baselineIndexByIdentity.get(identity) : undefined;
    if (baselineIndex !== undefined) {
      left = baselineIndex;
      break;
    }
  }
  let right: number | undefined;
  for (let index = insertedIndex + 1; index < input.live.length; index += 1) {
    const identity = blockIdentity(input.live[index]);
    const baselineIndex = identity ? baselineIndexByIdentity.get(identity) : undefined;
    if (baselineIndex !== undefined) {
      right = baselineIndex;
      break;
    }
  }
  if (left === undefined || right === undefined || left >= right) return false;
  return input.baseline
    .slice(left, right + 1)
    .every((block) => input.replacedBaselineHashes.has(block.hash));
}

function blockIdentity(block: BlockSnapshot | undefined): string | undefined {
  return block ? `${block.clientID}:${block.clock}` : undefined;
}
