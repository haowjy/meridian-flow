/** Projects branch journal ownership and push effects into durable change-trail records. */
import {
  type AgentEditModel,
  toDocHandle,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { NoticePort } from "../../notices/index.js";
import type {
  BranchJournalRow,
  PreparedPush,
  PublicationBlockChange,
  TrailContributionReplacement,
} from "./branch-push-contracts.js";
import { changedRangesByBlock, documentDifference } from "./document-difference.js";
import { type IndexedDraftUpdate, indexJournalClockOwners } from "./journal-clock-owners.js";
import type {
  ChangeTrailPersistence,
  DurableTrailRecord,
} from "./ports/change-trail-persistence.js";
import {
  bodyFromHashline,
  type CanonicalBlockIdentityV1,
  canonicalBlockKey,
  deletionBoundaryTarget,
  liveBlockTarget,
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
/**
 * The draft as it stood before `rows`, rebuilt from the draft's own state: every
 * struct the rows introduced is cut off and every deletion they made is lifted.
 * A draft's rows are authored in the draft's identity space, so replaying them
 * over a live doc would not land.
 */
export function draftPriorDoc(draftState: Uint8Array, rows: readonly BranchJournalRow[]): Y.Doc {
  const draft = createCollabYDoc({ gc: false });
  try {
    Y.applyUpdate(draft, draftState);
    const stateVector = Y.decodeStateVector(Y.encodeStateVector(draft));
    const rowDeletes = new Map<number, Array<{ clock: number; len: number }>>();
    for (const row of rows) {
      const decoded = Y.decodeUpdate(row.updateData);
      for (const struct of decoded.structs) {
        const cut = stateVector.get(struct.id.client);
        if (cut !== undefined && struct.id.clock < cut) {
          if (struct.id.clock === 0) stateVector.delete(struct.id.client);
          else stateVector.set(struct.id.client, struct.id.clock);
        }
      }
      for (const [client, items] of decoded.ds.clients) {
        let ranges = rowDeletes.get(client);
        if (!ranges) {
          ranges = [];
          rowDeletes.set(client, ranges);
        }
        for (const item of items) ranges.push(item);
      }
    }
    const deleteSet = Y.createDeleteSetFromStructStore(draft.store);
    for (const [client, lifted] of rowDeletes) {
      lifted.sort((a, b) => a.clock - b.clock);
      let gapIndex = 0;
      const kept: Array<{ clock: number; len: number }> = [];
      for (const item of deleteSet.clients.get(client) ?? []) {
        let start = item.clock;
        const end = item.clock + item.len;
        while (gapIndex < lifted.length) {
          const gap = lifted[gapIndex];
          if (gap.clock >= end) break;
          const gapEnd = gap.clock + gap.len;
          if (gapEnd > start) {
            if (gap.clock > start) kept.push({ clock: start, len: gap.clock - start });
            start = gapEnd;
          }
          // A lifted range can span several disjoint tombstones. Keep it for the next item.
          if (gapEnd >= end) break;
          gapIndex++;
        }
        if (start < end) kept.push({ clock: start, len: end - start });
      }
      deleteSet.clients.set(client, kept as never);
    }
    return Y.createDocFromSnapshot(
      draft,
      new Y.Snapshot(deleteSet, stateVector),
      createCollabYDoc({ gc: false }),
    );
  } finally {
    draft.destroy();
  }
}

export function journalAttributionByChangedBlock(input: {
  /** The draft before `rows`; see `draftPriorDoc`. */
  priorDoc: Y.Doc;
  rows: readonly BranchJournalRow[];
  model: YProsemirrorDocumentModel;
}): {
  ownersByBlock: Map<string, Array<{ threadId: ThreadId; turnId: TurnId } | null>>;
  operations: Array<{
    removedBlockHashes: string[];
    insertedBlockIds: string[];
    ambiguous?: boolean;
  }>;
} {
  const scratch = createCollabYDoc({ gc: false });
  const ownersByBlock = new Map<string, Array<{ threadId: ThreadId; turnId: TurnId } | null>>();
  const journalOperations: Array<{
    removedBlockHashes: string[];
    insertedBlockIds: string[];
    ambiguous?: boolean;
    removedIndex: number | null;
    insertedIndex: number | null;
    journalRowIndex: number;
  }> = [];
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(input.priorDoc));
    let before = canonicalSnapshot(input.model, scratch);
    for (const [journalRowIndex, row] of input.rows.entries()) {
      Y.applyUpdate(scratch, row.updateData);
      const after = canonicalSnapshot(input.model, scratch);
      const beforeByIdentity = new Map(before.map((block) => [block.identity, block]));
      const afterByIdentity = new Map(after.map((block) => [block.identity, block]));
      const deleted = before.filter((block) => !afterByIdentity.has(block.identity));
      const inserted = after.filter((block) => !beforeByIdentity.has(block.identity));
      if (deleted.length > 0 || inserted.length > 0) {
        journalOperations.push({
          removedBlockHashes: deleted.map((block) => block.hash),
          insertedBlockIds: inserted.map((block) => block.hash),
          ambiguous: deleted.length !== 1 || inserted.length !== 1,
          removedIndex:
            deleted.length === 1 ? before.indexOf(deleted[0] as (typeof before)[number]) : null,
          insertedIndex:
            inserted.length === 1 ? after.indexOf(inserted[0] as (typeof after)[number]) : null,
          journalRowIndex,
        });
      }
      before = after;
    }
    const rowsById = new Map(input.rows.map((row) => [String(row.id), row]));
    const operationIdsByBlock = draftOperationIdsByChangedBlock({
      priorDoc: input.priorDoc,
      draftDoc: scratch,
      model: input.model,
      draftUpdates: input.rows.map((row) => ({
        id: row.id,
        actorTurnId: row.turnId,
        actorUserId: row.actorUserId,
        updateData: row.updateData,
        updateMeta: row.updateMeta,
      })),
    });
    for (const [blockId, operationIds] of operationIdsByBlock) {
      const owners: Array<{ threadId: ThreadId; turnId: TurnId } | null> = [];
      for (const operationId of operationIds) {
        const row = rowsById.get(operationId);
        const owner =
          row?.threadId && row.turnId ? { threadId: row.threadId, turnId: row.turnId } : null;
        if (
          !owners.some(
            (existing) =>
              existing?.threadId === owner?.threadId && existing?.turnId === owner?.turnId,
          )
        )
          owners.push(owner);
      }
      ownersByBlock.set(blockId, owners.length > 0 ? owners : [null]);
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
        insertion.journalRowIndex === deletion.journalRowIndex + 1 &&
        deletion.removedIndex !== null &&
        deletion.removedIndex === insertion.insertedIndex
      ) {
        operations.push({
          removedBlockHashes: deletion.removedBlockHashes,
          insertedBlockIds: insertion.insertedBlockIds,
          ambiguous: false,
          removedIndex: deletion.removedIndex,
          insertedIndex: insertion.insertedIndex,
          journalRowIndex: deletion.journalRowIndex,
        });
        index += 1;
        continue;
      }
      operations.push(deletion as (typeof journalOperations)[number]);
    }
    return { ownersByBlock, operations };
  } finally {
    scratch.destroy();
  }
}

function canonicalSnapshot(model: YProsemirrorDocumentModel, doc: Y.Doc) {
  const handle = toDocHandle(doc);
  const hashes = model.getDocumentBlockIds(handle);
  return model.getBlocks(handle).map((block, index) => {
    const identity = model.getCanonicalBlockIdentity(block);
    return {
      hash: hashes[index],
      identity: `${identity.clientID}:${identity.clock}`,
    };
  });
}

export function preparedTrailChanges(input: {
  documentId: DocumentId;
  changedBlocks: readonly PublicationBlockChange[];
  receiptId: string;
  ownersByBlock: ReadonlyMap<string, readonly ({ threadId: ThreadId; turnId: TurnId } | null)[]>;
  /** Owners of a changed block the draft's identities do not name (a content Apply writes fresh live items). */
  fallbackOwners?: readonly ({ threadId: ThreadId; turnId: TurnId } | null)[];
  operations: readonly ReplacementOperation[];
  before: readonly {
    hash: string;
    serialized: string;
    clientID?: number;
    clock?: number;
  }[];
  blockIdentities: ReadonlyMap<string, CanonicalBlockIdentityV1>;
  afterIds: ReadonlySet<string>;
  afterById: ReadonlyMap<string, Y.XmlElement>;
  afterDoc: Y.Doc;
}): RawTrailChange[] {
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
  const candidateContentRelocations = new Map<string, string>();
  for (const target of input.changedBlocks) {
    if (
      target.beforeText === null ||
      target.afterText === null ||
      target.beforeText === target.afterText
    ) {
      continue;
    }
    const sources = input.changedBlocks.filter(
      (candidate) =>
        candidate.blockId !== target.blockId &&
        !provenReplacements.has(candidate.blockId) &&
        candidate.beforeText === target.afterText,
    );
    if (sources.length === 1) {
      candidateContentRelocations.set(target.blockId, sources[0]?.blockId as string);
    }
  }
  const sourceClaimCounts = new Map<string, number>();
  for (const sourceId of candidateContentRelocations.values()) {
    sourceClaimCounts.set(sourceId, (sourceClaimCounts.get(sourceId) ?? 0) + 1);
  }
  const directContentRelocations = new Map(
    [...candidateContentRelocations].filter(
      ([, sourceId]) => sourceClaimCounts.get(sourceId) === 1,
    ),
  );
  const changedBlockById = new Map(input.changedBlocks.map((block) => [block.blockId, block]));
  const contentRelocations = new Map<string, string>();
  for (const [targetId, sourceId] of directContentRelocations) {
    const visited = new Set([targetId]);
    let cursorId: string | undefined = sourceId;
    while (cursorId && !visited.has(cursorId)) {
      visited.add(cursorId);
      const cursor = changedBlockById.get(cursorId);
      if (cursor?.afterText === null) {
        contentRelocations.set(targetId, sourceId);
        break;
      }
      cursorId = directContentRelocations.get(cursorId);
    }
  }
  const relocatedSourceIds = new Set(contentRelocations.values());
  const survivingAfterBlockByIdentity = new Map<string, { blockId: string; block: Y.XmlElement }>();
  for (const [blockId, block] of input.afterById) {
    const identity = input.blockIdentities.get(blockId);
    if (identity) {
      survivingAfterBlockByIdentity.set(canonicalBlockKey(identity), { blockId, block });
    }
  }
  return input.changedBlocks.flatMap((block, sequence) => {
    if (relocatedSourceIds.has(block.blockId)) return [];
    if (block.beforeText === null && replacementIds.has(block.blockId)) return [];
    const beforeIdentity = block.beforeBlockIdentity
      ? { documentId: input.documentId, ...block.beforeBlockIdentity }
      : null;
    const beforeIndex = input.before.findIndex(
      (entry) =>
        beforeIdentity &&
        entry.clientID === beforeIdentity.clientID &&
        entry.clock === beforeIdentity.clock,
    );
    const nextId = input.before
      .slice(beforeIndex + 1)
      .find((entry) => input.afterIds.has(entry.hash))?.hash;
    const previousId = [...input.before.slice(0, Math.max(0, beforeIndex))]
      .reverse()
      .find((entry) => input.afterIds.has(entry.hash))?.hash;
    const ordinaryNavigation =
      block.afterText !== null && input.afterById.get(block.blockId)
        ? liveBlockTarget(input.afterDoc, input.afterById.get(block.blockId) as Y.XmlElement)
        : deletionBoundaryTarget({
            doc: input.afterDoc,
            next: nextId ? input.afterById.get(nextId) : null,
            previous: previousId ? input.afterById.get(previousId) : null,
          });
    const canonicalAfter =
      block.beforeText !== null && block.afterBlockIdentity
        ? survivingAfterBlockByIdentity.get(
            canonicalBlockKey({ documentId: input.documentId, ...block.afterBlockIdentity }),
          )
        : undefined;
    const contentRelocated = contentRelocations.has(block.blockId);
    const replacementId = canonicalAfter?.blockId ?? provenReplacements.get(block.blockId);
    const replacement = replacementId
      ? input.changedBlocks.find((candidate) => candidate.blockId === replacementId)
      : undefined;
    const replacementBlock =
      canonicalAfter?.block ?? (replacementId ? input.afterById.get(replacementId) : undefined);
    const beforeBody = bodyFromHashline(block.beforeText);
    const afterBody = bodyFromHashline(block.afterText);
    // A textblock can retain its Yjs identity while its entire body is removed.
    // Project that as a deletion at the surviving empty block, rather than as
    // an invisible modification range over zero text.
    const emptiedSurvivingBlock =
      canonicalAfter !== undefined &&
      beforeIdentity !== null &&
      block.afterBlockIdentity !== null &&
      beforeIdentity.clientID === block.afterBlockIdentity.clientID &&
      beforeIdentity.clock === block.afterBlockIdentity.clock &&
      block.beforeText !== null &&
      beforeBody.status === "available" &&
      beforeBody.markdown.length > 0 &&
      block.afterText !== null &&
      afterBody.status === "available" &&
      afterBody.markdown.length === 0;
    const owners = input.ownersByBlock.get(block.blockId) ?? input.fallbackOwners ?? [null];
    const afterBlockIdentity = replacement?.afterBlockIdentity ?? block.afterBlockIdentity;
    const afterIdentity =
      emptiedSurvivingBlock || contentRelocated || !afterBlockIdentity
        ? null
        : { documentId: input.documentId, ...afterBlockIdentity };
    const location: TrailProjectionLocation = {
      kind:
        emptiedSurvivingBlock || contentRelocated
          ? "delete"
          : replacementId !== undefined
            ? "modify"
            : block.beforeText === null
              ? "insert"
              : block.afterText === null
                ? "delete"
                : "modify",
      beforeIdentity,
      afterIdentity,
      navigation:
        emptiedSurvivingBlock || contentRelocated
          ? deletionBoundaryTarget({
              doc: input.afterDoc,
              next: canonicalAfter?.block ?? input.afterById.get(block.blockId) ?? null,
            })
          : canonicalAfter
            ? liveBlockTarget(input.afterDoc, canonicalAfter.block)
            : replacementBlock
              ? liveBlockTarget(input.afterDoc, replacementBlock)
              : ordinaryNavigation,
    };
    const stableIdentity = location.beforeIdentity ?? location.afterIdentity;
    if (!stableIdentity) return [];
    return owners.map((owner, ownerIndex) => ({
      changeId: `${input.receiptId}:${canonicalBlockKey(stableIdentity)}`,
      documentId: input.documentId,
      pushId: null,
      receiptId: input.receiptId,
      kind: location.kind,
      beforeBlockIdentity: location.beforeIdentity,
      afterBlockIdentity: location.afterIdentity,
      beforeText: block.beforeText,
      afterTextAtReceipt: contentRelocated
        ? null
        : canonicalAfter
          ? block.afterText
          : (replacement?.afterText ?? block.afterText),
      navigation: location.navigation,
      owner,
      sequence: sequence * 1000 + ownerIndex,
    }));
  });
}
/** Records every committed push's trail in one pass over each trail: one version per commit. */
export async function persistDurableTrailRecords(
  committed: readonly {
    record: DurableTrailRecord;
    push: { id: number; threadId?: ThreadId | null; turnId?: TurnId | null };
  }[],
  persistence: Pick<ChangeTrailPersistence, "record">,
  notices?: NoticePort,
): Promise<void> {
  const normalized = normalizeTrailPushes(
    committed.flatMap(({ record, push }) => {
      const pushId = String(push.id);
      const changes = record.changes.map((change) => ({ ...change, pushId }));
      return record.threadIds.map((threadId) => ({
        pushId,
        receiptId: record.receiptId,
        threadId,
        changes,
        journalOwners: record.journalOwners,
      }));
    }),
  );
  await persistence.record({
    trails: normalized,
    documentTitles: new Map(
      committed.map(({ record }) => [record.documentId, record.documentTitle]),
    ),
  });
  for (const { record, push } of committed) {
    if (!record.transactionalNotice) continue;
    await notices?.record({
      ...record.transactionalNotice,
      data: {
        ...record.transactionalNotice.data,
        pushId: String(push.id),
        threadId: push.threadId ?? null,
        turnId: push.turnId ?? null,
      },
    });
  }
}

export function trailContributionReplacement(
  record: DurableTrailRecord,
  push: { id: number },
  contribution: DurableTrailRecord["changes"] = record.changes,
): TrailContributionReplacement {
  const pushId = String(push.id);
  const changes = record.changes.map((change) => ({ ...change, pushId }));
  const trails = normalizeTrailPushes(
    record.threadIds.map((threadId) => ({
      pushId,
      receiptId: record.receiptId,
      threadId,
      changes,
      journalOwners: record.journalOwners,
    })),
  );
  const normalizedContribution = normalizeTrailPushes(
    record.threadIds.map((threadId) => ({
      pushId,
      receiptId: record.receiptId,
      threadId,
      changes: contribution.map((change) => ({ ...change, pushId })),
      journalOwners: record.journalOwners,
    })),
  );
  const contributionByOwner = new Map(
    normalizedContribution.map((trail) => [JSON.stringify(trail.owner), trail.changes]),
  );
  return {
    targets: trails.map((trail) => ({
      owner: trail.owner,
      changes: contributionByOwner.get(JSON.stringify(trail.owner)) ?? [],
    })),
    documentTitles: new Map([[record.documentId, record.documentTitle]]),
  };
}

export function buildDurablePushTrail(input: {
  prepared: PreparedPush;
  documentTitle: string;
}): DurableTrailRecord {
  // A manifest push is owned by the rows it moves; a content Apply by the draft's pending rows (the
  // rows that fed `attributionRows`), since it writes fresh live items and moves none.
  const rows = input.prepared.attributionRows;
  const journalOwners = rows.map((row) =>
    row.threadId && row.turnId ? { threadId: row.threadId, turnId: row.turnId } : null,
  );
  const threadIds = new Set(rows.flatMap((row) => (row.threadId ? [row.threadId] : [])));
  return {
    documentId: input.prepared.prepared.branch.documentId,
    documentTitle: input.documentTitle,
    receiptId: input.prepared.prepared.receiptId as string,
    threadIds: [...threadIds],
    journalOwners,
    changes: input.prepared.trailChanges,
  };
}

/** Net publication ownership uses the same clock attribution as review, not canceled keystrokes. */
function draftOperationIdsByChangedBlock(input: {
  priorDoc: Y.Doc;
  draftDoc: Y.Doc;
  model: AgentEditModel;
  draftUpdates: readonly IndexedDraftUpdate[];
}): Map<string, string[]> {
  const attribution = indexJournalClockOwners({
    baseDoc: input.priorDoc,
    updates: input.draftUpdates,
  });
  const result = new Map<string, string[]>();
  for (const [blockKey, ranges] of changedRangesByBlock(
    documentDifference(input.priorDoc, input.draftDoc, input.model),
  ))
    result.set(blockKey, attribution.owningRowIds(ranges));
  return result;
}
