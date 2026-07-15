/** Projects branch journal ownership and push effects into durable change-trail records. */
import { diffSnapshots, type YProsemirrorDocumentModel } from "@meridian/agent-edit";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { NoticePort } from "../../notices/index.js";
import type { BranchJournalRow, PushReceiptPayload } from "./branch-push.js";
import { blockTextMap } from "./branch-push-plan.js";
import type {
  ChangeTrailPersistence,
  DurableTrailRecord,
} from "./ports/change-trail-persistence.js";
import {
  bodyFromHashline,
  deletionBoundaryTarget,
  liveBlockTarget,
  navigationForSweptBlock,
  normalizeTrailPushes,
  type RawTrailChange,
  type ReplacementOperation,
} from "./trail-read-kernel.js";
export function journalAttributionByChangedBlock(input: {
  liveDoc: Y.Doc;
  rows: readonly BranchJournalRow[];
  model: YProsemirrorDocumentModel;
}): {
  ownersByBlock: Map<string, Array<{ threadId: ThreadId; turnId: TurnId } | null>>;
  operations: Array<{ removedBlockHashes: string[]; insertedBlockIds: string[] }>;
  authoringResponseIdsByBlock: Map<string, string[]>;
} {
  const scratch = createCollabYDoc({ gc: false });
  const ownersByBlock = new Map<string, Array<{ threadId: ThreadId; turnId: TurnId } | null>>();
  const operations: Array<{ removedBlockHashes: string[]; insertedBlockIds: string[] }> = [];
  const authoringResponseIdsByBlock = new Map<string, string[]>();
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(input.liveDoc));
    for (const row of input.rows) {
      const before = blockTextMap(input.model, scratch);
      Y.applyUpdate(scratch, row.updateData);
      const after = blockTextMap(input.model, scratch);
      const owner =
        row.threadId && row.turnId ? { threadId: row.threadId, turnId: row.turnId } : null;
      for (const blockId of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(blockId) === after.get(blockId)) continue;
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
      const diff = diffSnapshots(
        [...before].map(([hash, serialized]) => ({ hash, serialized })),
        [...after].map(([hash, serialized]) => ({ hash, serialized })),
      );
      const responseId = (row.updateMeta as { authoringResponseId?: unknown } | null)
        ?.authoringResponseId;
      if (typeof responseId === "string") {
        for (const blockId of new Set([...diff.changed, ...diff.deleted, ...diff.inserted])) {
          const ids = authoringResponseIdsByBlock.get(blockId) ?? [];
          if (!ids.includes(responseId)) ids.push(responseId);
          authoringResponseIdsByBlock.set(blockId, ids);
        }
      }
      if (diff.deleted.size > 0 || diff.inserted.size > 0) {
        operations.push({
          removedBlockHashes: [...diff.deleted],
          insertedBlockIds: [...diff.inserted],
        });
      }
    }
    return { ownersByBlock, operations, authoringResponseIdsByBlock };
  } finally {
    scratch.destroy();
  }
}

export function preparedTrailChanges(input: {
  receipt: PushReceiptPayload;
  receiptId: string;
  ownersByBlock: ReadonlyMap<string, readonly ({ threadId: ThreadId; turnId: TurnId } | null)[]>;
  operations: readonly ReplacementOperation[];
  conflictedBlocks: readonly string[];
  before: readonly { hash: string; serialized: string }[];
  beforeBodies: ReadonlyMap<string, string>;
  afterIds: ReadonlySet<string>;
  afterById: ReadonlyMap<string, Y.XmlElement>;
  afterDoc: Y.Doc;
  beforeContentRef: number | null;
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
    const ordinaryNavigation =
      block.afterText !== null && input.afterById.get(block.blockId)
        ? liveBlockTarget(input.afterDoc, input.afterById.get(block.blockId) as Y.XmlElement)
        : deletionBoundaryTarget({
            doc: input.afterDoc,
            next: nextId ? input.afterById.get(nextId) : null,
            previous: previousId ? input.afterById.get(previousId) : null,
          });
    const sweptNavigation = isSwept
      ? navigationForSweptBlock({
          affectedBlockHash: block.blockId,
          afterDoc: input.afterDoc,
          operations: input.operations,
          nextSurvivor: nextId ? input.afterById.get(nextId) : null,
          previousSurvivor: previousId ? input.afterById.get(previousId) : null,
        })
      : null;
    const replacementId =
      sweptNavigation?.outcome === "modify" ? provenReplacements.get(block.blockId) : undefined;
    const replacement = replacementId
      ? input.receipt.changedBlocks.find((candidate) => candidate.blockId === replacementId)
      : undefined;
    const owners = input.ownersByBlock.get(block.blockId) ?? [null];
    return owners.map((owner, ownerIndex) => ({
      changeId: `${input.receiptId}:${block.blockId}`,
      documentId: input.receipt.documentId,
      pushId: null,
      receiptId: input.receiptId,
      kind:
        sweptNavigation?.outcome ??
        (block.beforeText === null ? "insert" : block.afterText === null ? "delete" : "modify"),
      beforeBlockId: block.beforeText === null ? null : block.blockId,
      afterBlockId: replacementId ?? (block.afterText === null ? null : block.blockId),
      beforeText: block.beforeText,
      afterTextAtReceipt: replacement?.afterText ?? block.afterText,
      navigation: sweptNavigation?.navigation ?? ordinaryNavigation,
      swept: isSwept
        ? {
            affectedBlockHash: block.blockId,
            removed: bodyFromHashline(input.beforeBodies.get(block.blockId) ?? null),
            beforeContentRef: input.beforeContentRef,
          }
        : null,
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
  await persistence.record({
    trails: normalizeTrailPushes(
      record.threadIds.map((threadId) => ({
        pushId,
        receiptId: record.receiptId,
        threadId,
        changes,
        journalOwners: record.journalOwners,
      })),
    ),
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
