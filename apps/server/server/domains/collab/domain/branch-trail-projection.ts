/** Projects branch journal ownership and push effects into durable change-trail records. */
import { toDocHandle, type YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { NoticePort } from "../../notices/index.js";
import type {
  BranchJournalRow,
  PreparedPush,
  PushReceiptPayload,
  TrailContributionReplacement,
} from "./branch-push-contracts.js";
import { blockTextMap } from "./branch-push-plan.js";
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
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(input.liveDoc));
    for (const [journalRowIndex, row] of input.rows.entries()) {
      const before = canonicalSnapshot(input.model, scratch);
      Y.applyUpdate(scratch, row.updateData);
      const after = canonicalSnapshot(input.model, scratch);
      const beforeByIdentity = new Map(before.map((block) => [block.identity, block]));
      const afterByIdentity = new Map(after.map((block) => [block.identity, block]));
      const owner =
        row.threadId && row.turnId ? { threadId: row.threadId, turnId: row.turnId } : null;
      for (const identity of new Set([...beforeByIdentity.keys(), ...afterByIdentity.keys()])) {
        const prior = beforeByIdentity.get(identity);
        const next = afterByIdentity.get(identity);
        if (prior?.serialized === next?.serialized) continue;
        const blockId = next?.hash ?? prior?.hash;
        if (!blockId) continue;
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
  before: readonly { hash: string; serialized: string }[];
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
  for (const target of input.receipt.changedBlocks) {
    if (
      target.beforeText === null ||
      target.afterText === null ||
      target.beforeText === target.afterText
    ) {
      continue;
    }
    const sources = input.receipt.changedBlocks.filter(
      (candidate) =>
        candidate.blockId !== target.blockId && candidate.beforeText === target.afterText,
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
  const changedBlockById = new Map(
    input.receipt.changedBlocks.map((block) => [block.blockId, block]),
  );
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
  const survivingAfterBlockByIdentity = new Map<
    string,
    { blockId: string; block: Y.XmlElement; identity: CanonicalBlockIdentityV1 }
  >();
  for (const [blockId, block] of input.afterById) {
    const identity = input.blockIdentities.get(blockId);
    if (identity) {
      survivingAfterBlockByIdentity.set(canonicalBlockKey(identity), { blockId, block, identity });
    }
  }
  return input.receipt.changedBlocks.flatMap((block, sequence) => {
    if (relocatedSourceIds.has(block.blockId)) return [];
    if (block.beforeText === null && replacementIds.has(block.blockId)) return [];
    const beforeIndex = input.before.findIndex((entry) => entry.hash === block.blockId);
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
    const beforeIdentity =
      block.beforeText === null ? null : (input.blockIdentities.get(block.blockId) ?? null);
    const sameIdentityAfter =
      block.beforeText !== null && block.afterText !== null && beforeIdentity
        ? survivingAfterBlockByIdentity.get(canonicalBlockKey(beforeIdentity))
        : undefined;
    const contentRelocated = contentRelocations.has(block.blockId);
    const replacementId = sameIdentityAfter?.blockId ?? provenReplacements.get(block.blockId);
    const replacement = replacementId
      ? input.receipt.changedBlocks.find((candidate) => candidate.blockId === replacementId)
      : undefined;
    const replacementBlock =
      sameIdentityAfter?.block ?? (replacementId ? input.afterById.get(replacementId) : undefined);
    const beforeBody = bodyFromHashline(block.beforeText);
    const afterBody = bodyFromHashline(block.afterText);
    // A textblock can retain its Yjs identity while its entire body is removed.
    // Project that as a deletion at the surviving empty block, rather than as
    // an invisible modification range over zero text.
    const emptiedSurvivingBlock =
      sameIdentityAfter !== undefined &&
      block.beforeText !== null &&
      beforeBody.status === "available" &&
      beforeBody.markdown.length > 0 &&
      block.afterText !== null &&
      afterBody.status === "available" &&
      afterBody.markdown.length === 0;
    const owners = input.ownersByBlock.get(block.blockId) ?? [null];
    const afterIdentity = emptiedSurvivingBlock
      ? null
      : contentRelocated
        ? null
        : (sameIdentityAfter?.identity ??
          (replacementId !== undefined
            ? (input.blockIdentities.get(replacementId) ?? null)
            : block.afterText === null
              ? null
              : (input.blockIdentities.get(block.blockId) ?? null)));
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
              next: sameIdentityAfter?.block ?? input.afterById.get(block.blockId) ?? null,
            })
          : sameIdentityAfter
            ? liveBlockTarget(input.afterDoc, sameIdentityAfter.block)
            : replacementBlock
              ? liveBlockTarget(input.afterDoc, replacementBlock)
              : ordinaryNavigation,
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
      afterBlockId:
        emptiedSurvivingBlock || contentRelocated
          ? null
          : (replacementId ?? (block.afterText === null ? null : block.blockId)),
      beforeBlockIdentity: location.beforeIdentity,
      afterBlockIdentity: location.afterIdentity,
      beforeText: block.beforeText,
      afterTextAtReceipt: contentRelocated
        ? null
        : sameIdentityAfter
          ? block.afterText
          : (replacement?.afterText ?? block.afterText),
      navigation: location.navigation,
      owner,
      sequence: sequence * 1000 + ownerIndex,
    }));
  });
}
export async function persistDurableTrailRecord(
  record: DurableTrailRecord,
  push: { id: number; threadId?: ThreadId | null; turnId?: TurnId | null },
  persistence: Pick<ChangeTrailPersistence, "record">,
  notices?: NoticePort,
): Promise<void> {
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
  await persistence.record({
    trails: normalized,
    documentTitles: new Map([[record.documentId, record.documentTitle]]),
  });
  if (record.transactionalNotice) {
    await notices?.record({
      ...record.transactionalNotice,
      data: {
        ...record.transactionalNotice.data,
        pushId,
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
  const journalOwners = input.prepared.prepared.journalRows.map((row) =>
    row.threadId && row.turnId ? { threadId: row.threadId, turnId: row.turnId } : null,
  );
  const threadIds = new Set(
    input.prepared.prepared.journalRows.flatMap((row) => (row.threadId ? [row.threadId] : [])),
  );
  return {
    documentId: input.prepared.prepared.branch.documentId,
    documentTitle: input.documentTitle,
    receiptId: input.prepared.prepared.receiptId as string,
    threadIds: [...threadIds],
    journalOwners,
    changes: input.prepared.trailChanges,
  };
}
