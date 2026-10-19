/** Canonical live-effect trail navigation and committed-record persistence. */
import type { CanonicalBlockIdentity } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { NoticePort } from "../../notices/index.js";

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

export function preparedTrailChanges(input: {
  documentId: DocumentId;
  changedBlocks: readonly ApplyBlockChange[];
  receiptId: string;
  ownersByBlock: ReadonlyMap<string, readonly ({ threadId: ThreadId; turnId: TurnId } | null)[]>;
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
    const owners = input.ownersByBlock.get(block.blockId) ?? [null];
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

type ApplyBlockChange = {
  blockId: string;
  beforeBlockIdentity: CanonicalBlockIdentity | null;
  afterBlockIdentity: CanonicalBlockIdentity | null;
  beforeText: string | null;
  afterText: string | null;
};
