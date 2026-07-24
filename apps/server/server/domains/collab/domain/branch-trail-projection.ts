/** Projects branch journal ownership and push effects into durable change-trail records. */
import { toDocHandle, type YProsemirrorDocumentModel } from "@meridian/agent-edit";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchJournalRow, PushReceiptPayload } from "./branch-push.js";
import { blockTextMap } from "./branch-push-plan.js";
import type {
  ChangeTrailPersistence,
  CommittedChangeTrailProjection,
  DurableTrailRecord,
} from "./ports/change-trail-persistence.js";
import {
  bodyFromHashline,
  type CanonicalBlockIdentityV1,
  canonicalBlockKey,
  deletionBoundaryTarget,
  liveBlockTarget,
  navigationForSweptBlock,
  normalizeTrailPushes,
  type RawTrailChange,
  type ReplacementOperation,
} from "./trail-read-kernel.js";

type TrailProjectionLocation = {
  kind: RawTrailChange["kind"];
  beforeIdentity: CanonicalBlockIdentityV1 | null;
  afterIdentity: CanonicalBlockIdentityV1 | null;
  navigation: RawTrailChange["navigation"];
};
export function journalAttributionByChangedBlock(input: {
  liveDoc: Y.Doc;
  rows: readonly BranchJournalRow[];
  model: YProsemirrorDocumentModel;
}): {
  ownersByBlock: Map<string, Array<{ threadId: ThreadId; turnId: TurnId } | null>>;
  operations: Array<{
    removedBlockHashes: string[];
    insertedBlockIds: string[];
    ambiguous?: boolean;
  }>;
  authoringResponseIdsByBlock: Map<string, string[]>;
} {
  const scratch = createCollabYDoc({ gc: false });
  const ownersByBlock = new Map<string, Array<{ threadId: ThreadId; turnId: TurnId } | null>>();
  const journalOperations: Array<{
    removedBlockHashes: string[];
    insertedBlockIds: string[];
    ambiguous?: boolean;
    removedIndex: number | null;
    insertedIndex: number | null;
  }> = [];
  const authoringResponseIdsByBlock = new Map<string, string[]>();
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(input.liveDoc));
    for (const row of input.rows) {
      const before = canonicalSnapshot(input.model, scratch);
      Y.applyUpdate(scratch, row.updateData);
      const after = canonicalSnapshot(input.model, scratch);
      const beforeByIdentity = new Map(before.map((block) => [block.identity, block]));
      const afterByIdentity = new Map(after.map((block) => [block.identity, block]));
      const owner =
        row.threadId && row.turnId ? { threadId: row.threadId, turnId: row.turnId } : null;
      const affectedBlockIds: string[] = [];
      for (const identity of new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])) {
        const prior = beforeByIdentity.get(identity);
        const next = afterByIdentity.get(identity);
        if (prior?.serialized === next?.serialized) continue;
        const blockId = next?.hash ?? prior?.hash;
        if (!blockId) continue;
        affectedBlockIds.push(blockId);
        const owners = ownersByBlock.get(blockId) ?? [];
        if (
          !owners.some(
            (existing) =>
              existing?.threadId === owner?.threadId && existing?.turnId === owner?.turnId,
          )
        ) {
          owners.push(owner);
          ownersByBlock.set(blockId, owners);
        }
      }
      const deleted = before.filter((block) => !afterByIdentity.has(block.identity));
      const inserted = after.filter((block) => !beforeByIdentity.has(block.identity));
      const responseId = (row.updateMeta as { authoringResponseId?: unknown } | null)
        ?.authoringResponseId;
      if (typeof responseId === "string") {
        for (const blockId of affectedBlockIds) {
          const ids = authoringResponseIdsByBlock.get(blockId) ?? [];
          if (!ids.includes(responseId)) ids.push(responseId);
          authoringResponseIdsByBlock.set(blockId, ids);
        }
      }
      if (deleted.length > 0 || inserted.length > 0) {
        journalOperations.push({
          removedBlockHashes: deleted.map((block) => block.hash),
          insertedBlockIds: inserted.map((block) => block.hash),
          ambiguous: deleted.length !== 1 || inserted.length !== 1,
          removedIndex:
            deleted.length === 1 ? before.indexOf(deleted[0] as (typeof before)[number]) : null,
          insertedIndex:
            inserted.length === 1 ? after.indexOf(inserted[0] as (typeof after)[number]) : null,
        });
      }
    }
    const operations: typeof journalOperations = [];
    for (let index = 0; index < journalOperations.length; index += 1) {
      const deletion = journalOperations[index];
      const insertion = journalOperations[index + 1];
      if (
        deletion?.removedBlockHashes.length === 1 &&
        deletion.insertedBlockIds.length === 0 &&
        insertion?.removedBlockHashes.length === 0 &&
        insertion.insertedBlockIds.length === 1 &&
        deletion.removedIndex !== null &&
        deletion.removedIndex === insertion.insertedIndex
      ) {
        operations.push({
          removedBlockHashes: deletion.removedBlockHashes,
          insertedBlockIds: insertion.insertedBlockIds,
          ambiguous: false,
          removedIndex: deletion.removedIndex,
          insertedIndex: insertion.insertedIndex,
        });
        index += 1;
        continue;
      }
      operations.push(deletion as (typeof journalOperations)[number]);
    }
    return { ownersByBlock, operations, authoringResponseIdsByBlock };
  } finally {
    scratch.destroy();
  }
}

function canonicalSnapshot(model: YProsemirrorDocumentModel, doc: Y.Doc) {
  const text = blockTextMap(model, doc);
  const blocks = model.getBlocks(toDocHandle(doc));
  return [...text].map(([hash, serialized], index) => {
    const identity = blocks[index] ? model.getCanonicalBlockIdentity(blocks[index]) : null;
    return {
      hash,
      serialized,
      identity: identity ? `${identity.clientID}:${identity.clock}` : `missing:${hash}`,
    };
  });
}

export function preparedTrailChanges(input: {
  receipt: PushReceiptPayload;
  receiptId: string;
  ownersByBlock: ReadonlyMap<string, readonly ({ threadId: ThreadId; turnId: TurnId } | null)[]>;
  operations: readonly ReplacementOperation[];
  conflictedBlocks: readonly string[];
  before: readonly { hash: string; serialized: string }[];
  blockIdentities: ReadonlyMap<string, CanonicalBlockIdentityV1>;
  beforeBodies: ReadonlyMap<string, string>;
  afterIds: ReadonlySet<string>;
  afterById: ReadonlyMap<string, Y.XmlElement>;
  afterDoc: Y.Doc;
  beforeContentRef: number | null;
  resurrectionBodies?: ReadonlyMap<string, string>;
}): RawTrailChange[] {
  const swept = new Set(input.conflictedBlocks);
  const provenReplacements = new Map<string, string>();
  for (const operation of input.operations) {
    if (
      !operation.ambiguous &&
      operation.removedBlockHashes.length === 1 &&
      operation.insertedBlocks.length === 1
    ) {
      provenReplacements.set(
        operation.removedBlockHashes[0] as string,
        operation.insertedBlocks[0]?.blockId as string,
      );
    }
  }
  const replacementIds = new Set(provenReplacements.values());
  return input.receipt.changedBlocks.flatMap((block, sequence) => {
    if (block.beforeText === null && replacementIds.has(block.blockId)) return [];
    const beforeIndex = input.before.findIndex((entry) => entry.hash === block.blockId);
    const nextId = input.before
      .slice(beforeIndex + 1)
      .find((entry) => input.afterIds.has(entry.hash))?.hash;
    const previousId = [...input.before.slice(0, Math.max(0, beforeIndex))]
      .reverse()
      .find((entry) => input.afterIds.has(entry.hash))?.hash;
    const isSwept = swept.has(block.blockId);
    const resurrectionBody = input.resurrectionBodies?.get(block.blockId);
    const wholeDocumentReplacement =
      isSwept &&
      input.before.length === 1 &&
      input.before[0]?.hash === block.blockId &&
      !nextId &&
      !previousId
        ? input.afterDoc.getXmlFragment("prosemirror").get(0)
        : null;
    const safeNextBoundary =
      wholeDocumentReplacement instanceof Y.XmlElement ? wholeDocumentReplacement : null;
    const ordinaryNavigation =
      block.afterText !== null && input.afterById.get(block.blockId)
        ? liveBlockTarget(input.afterDoc, input.afterById.get(block.blockId) as Y.XmlElement)
        : deletionBoundaryTarget({
            doc: input.afterDoc,
            next: nextId ? input.afterById.get(nextId) : safeNextBoundary,
            previous: previousId ? input.afterById.get(previousId) : null,
          });
    const sweptNavigation =
      isSwept && resurrectionBody === undefined
        ? navigationForSweptBlock({
            affectedBlockHash: block.blockId,
            afterDoc: input.afterDoc,
            operations: input.operations,
            nextSurvivor: nextId ? input.afterById.get(nextId) : safeNextBoundary,
            previousSurvivor: previousId ? input.afterById.get(previousId) : null,
          })
        : null;
    const replacementId = provenReplacements.get(block.blockId);
    const replacement = replacementId
      ? input.receipt.changedBlocks.find((candidate) => candidate.blockId === replacementId)
      : undefined;
    const replacementBlock = replacementId ? input.afterById.get(replacementId) : undefined;
    const owners = input.ownersByBlock.get(block.blockId) ?? [null];
    const beforeIdentity =
      block.beforeText === null ? null : (input.blockIdentities.get(block.blockId) ?? null);
    const afterIdentity =
      replacementId !== undefined
        ? (input.blockIdentities.get(replacementId) ?? null)
        : block.afterText === null
          ? null
          : (input.blockIdentities.get(block.blockId) ?? null);
    const location: TrailProjectionLocation = {
      kind:
        replacementId !== undefined
          ? "modify"
          : (sweptNavigation?.outcome ??
            (block.beforeText === null
              ? "insert"
              : block.afterText === null
                ? "delete"
                : "modify")),
      beforeIdentity,
      afterIdentity,
      navigation:
        sweptNavigation?.navigation ??
        (replacementBlock ? liveBlockTarget(input.afterDoc, replacementBlock) : ordinaryNavigation),
    };
    const stableIdentity = location.beforeIdentity ?? location.afterIdentity;
    if (!stableIdentity) return [];
    return owners.map((owner, ownerIndex) => ({
      changeId: `${input.receiptId}:${canonicalBlockKey(stableIdentity)}`,
      documentId: input.receipt.documentId,
      pushId: null,
      receiptId: input.receiptId,
      kind: location.kind,
      beforeBlockId: block.beforeText === null ? null : block.blockId,
      afterBlockId: replacementId ?? (block.afterText === null ? null : block.blockId),
      beforeBlockIdentity: location.beforeIdentity,
      afterBlockIdentity: location.afterIdentity,
      beforeText: block.beforeText,
      afterTextAtReceipt: replacement?.afterText ?? block.afterText,
      navigation: location.navigation,
      swept: isSwept
        ? {
            affectedBlockHash: block.blockId,
            affectedBlockIdentity: stableIdentity,
            removed: bodyFromHashline(input.beforeBodies.get(block.blockId) ?? null),
            beforeContentRef: input.beforeContentRef,
          }
        : null,
      ...(resurrectionBody !== undefined
        ? {
            writerProtection: {
              kind: "resurrection" as const,
              body: bodyFromHashline(resurrectionBody),
            },
          }
        : isSwept
          ? {
              writerProtection: {
                kind: "sweep" as const,
                body: bodyFromHashline(input.beforeBodies.get(block.blockId) ?? null),
              },
            }
          : {}),
      owner,
      sequence: sequence * 1000 + ownerIndex,
    }));
  });
}
export async function persistDurableTrailRecord(
  record: DurableTrailRecord,
  push: { id: number; threadId?: ThreadId | null; turnId?: TurnId | null },
  persistence: Pick<ChangeTrailPersistence, "record">,
  options: {
    refineCurrentVersion?: boolean;
    refineToEmpty?: boolean;
    replacePushContribution?: boolean;
  } = {},
): Promise<readonly CommittedChangeTrailProjection[]> {
  const pushId = String(push.id);
  const changes = record.changes.map((change) => ({ ...change, pushId }));
  const normalized = normalizeTrailPushes(
    record.threadIds.map((threadId) => ({
      pushId,
      receiptId: record.receiptId,
      threadId,
      changes,
      journalOwners: record.journalOwners,
    })),
  );
  const committed = await persistence.record({
    trails: options.refineToEmpty
      ? normalized.map((trail) => ({
          ...trail,
          changes: [],
          counts: { changes: 0, swept: 0, documents: 0 },
        }))
      : normalized,
    documentTitles: new Map([[record.documentId, record.documentTitle]]),
    ...(options.refineCurrentVersion ? { refineCurrentVersion: true } : {}),
    ...(options.refineToEmpty || options.replacePushContribution ? { replacePushId: pushId } : {}),
  });
  return committed;
}
