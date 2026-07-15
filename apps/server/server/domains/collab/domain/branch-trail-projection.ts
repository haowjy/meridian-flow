/** Projects branch journal ownership and push effects into durable change-trail records. */
import { toDocHandle, type YProsemirrorDocumentModel } from "@meridian/agent-edit";
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
  type CanonicalBlockIdentityV1,
  canonicalBlockKey,
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
  operations: Array<{
    removedBlockHashes: string[];
    insertedBlockIds: string[];
    ambiguous?: boolean;
  }>;
  authoringResponseIdsByBlock: Map<string, string[]>;
} {
  const scratch = createCollabYDoc({ gc: false });
  const ownersByBlock = new Map<string, Array<{ threadId: ThreadId; turnId: TurnId } | null>>();
  const operations: Array<{
    removedBlockHashes: string[];
    insertedBlockIds: string[];
    ambiguous?: boolean;
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
        operations.push({
          removedBlockHashes: deleted.map((block) => block.hash),
          insertedBlockIds: inserted.map((block) => block.hash),
          ambiguous: deleted.length !== 1 || inserted.length !== 1,
        });
      }
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
    const ordinaryNavigation =
      block.afterText !== null && input.afterById.get(block.blockId)
        ? liveBlockTarget(input.afterDoc, input.afterById.get(block.blockId) as Y.XmlElement)
        : deletionBoundaryTarget({
            doc: input.afterDoc,
            next: nextId ? input.afterById.get(nextId) : null,
            previous: previousId ? input.afterById.get(previousId) : null,
          });
    const sweptNavigation =
      isSwept && resurrectionBody === undefined
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
    const beforeIdentity =
      block.beforeText === null ? null : (input.blockIdentities.get(block.blockId) ?? null);
    const afterIdentity =
      block.afterText === null
        ? null
        : (input.blockIdentities.get(replacementId ?? block.blockId) ?? null);
    const stableIdentity = beforeIdentity ?? afterIdentity;
    if (!stableIdentity) return [];
    return owners.map((owner, ownerIndex) => ({
      changeId: `${input.receiptId}:${canonicalBlockKey(stableIdentity)}`,
      documentId: input.receipt.documentId,
      pushId: null,
      receiptId: input.receiptId,
      kind:
        sweptNavigation?.outcome ??
        (block.beforeText === null ? "insert" : block.afterText === null ? "delete" : "modify"),
      beforeBlockId: block.beforeText === null ? null : block.blockId,
      afterBlockId: replacementId ?? (block.afterText === null ? null : block.blockId),
      beforeBlockIdentity: beforeIdentity,
      afterBlockIdentity: afterIdentity,
      beforeText: block.beforeText,
      afterTextAtReceipt: replacement?.afterText ?? block.afterText,
      navigation: sweptNavigation?.navigation ?? ordinaryNavigation,
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
  notices?: NoticePort,
  options: { refineCurrentVersion?: boolean } = {},
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
    ...(options.refineCurrentVersion ? { refineCurrentVersion: true } : {}),
  });
  if (record.transactionalNotice && !options.refineCurrentVersion) {
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
