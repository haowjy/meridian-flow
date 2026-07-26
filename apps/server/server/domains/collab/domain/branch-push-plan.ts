/** Pure document materialization and effect-verification primitives for branch pushes. */
import { createHash } from "node:crypto";
import { toDocHandle, type YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import type { BranchJournalRow, PublicationBlockChange } from "./branch-push-contracts.js";
import {
  decodeUpdateForDependencies,
  deleteRanges,
  rangeCovers,
  suppliedRanges,
} from "./journal-dependencies.js";
export class BranchPushEffectVerificationError extends Error {
  constructor(
    readonly operation: string,
    readonly journalIds: readonly number[],
    readonly reason: string,
  ) {
    super(
      `${operation} did not integrate selected Yjs effects (${reason}) for journal rows ${journalIds.join(",")}`,
    );
    this.name = "BranchPushEffectVerificationError";
  }
}

export function assertRowsIntegrated(
  doc: Y.Doc,
  rows: readonly BranchJournalRow[],
  operation: string,
): void {
  const stateVector = Y.decodeStateVector(Y.encodeStateVector(doc));
  const docDeleteRanges = deleteRanges(decodeUpdateForDependencies(Y.encodeStateAsUpdate(doc)));
  for (const row of rows) {
    const decoded = decodeUpdateForDependencies(row.updateData);
    for (const range of suppliedRanges(decoded)) {
      if ((stateVector.get(range.client) ?? 0) < range.clock + range.length) {
        throw new BranchPushEffectVerificationError(operation, [row.id], "missing_struct_range");
      }
    }
    for (const range of deleteRanges(decoded)) {
      if (!docDeleteRanges.some((candidate) => rangeCovers(candidate, range))) {
        throw new BranchPushEffectVerificationError(operation, [row.id], "missing_delete_range");
      }
    }
  }
}

export function wholeBranchPushUpdate(input: { branchDoc: Y.Doc; liveDoc: Y.Doc }): Uint8Array {
  return Y.encodeStateAsUpdate(input.branchDoc, Y.encodeStateVector(input.liveDoc));
}

export function publicationBlockChanges(input: {
  model: YProsemirrorDocumentModel;
  beforeDoc: Y.Doc;
  afterDoc: Y.Doc;
}): PublicationBlockChange[] {
  const before = blockTextMap(input.model, input.beforeDoc);
  const after = blockTextMap(input.model, input.afterDoc);
  const blockIds = new Set([...before.keys(), ...after.keys()]);
  return [...blockIds]
    .filter((blockId) => before.get(blockId) !== after.get(blockId))
    .sort()
    .map((blockId) => ({
      blockId,
      beforeText: before.get(blockId) ?? null,
      afterText: after.get(blockId) ?? null,
    }));
}

export function blockTextMap(model: YProsemirrorDocumentModel, doc: Y.Doc): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of model.getBlocks(toDocHandle(doc))) {
    result.set(model.getBlockId(block), model.getText(block));
  }
  return result;
}

export function stablePushIdempotencyKey(input: {
  branchId: string;
  generation: number;
  journalIds: number[];
  publicationKind: "content" | "manifest";
}): string {
  return createHash("sha256")
    .update(input.branchId)
    .update("\0")
    .update(String(input.generation))
    .update("\0")
    .update(input.publicationKind)
    .update("\0")
    .update([...input.journalIds].sort((a, b) => a - b).join(","))
    .digest("hex");
}
export class BranchPeerIntegrationError extends Error {
  constructor(
    readonly operation: string,
    readonly journalIds: readonly number[],
  ) {
    super(`${operation} left pending Yjs dependencies for journal rows ${journalIds.join(",")}`);
    this.name = "BranchPeerIntegrationError";
  }
}

export function assertNoPendingIntegration(
  doc: Y.Doc,
  operation: string,
  journalIds: readonly number[],
): void {
  const store = (doc as unknown as { store?: { pendingStructs?: unknown; pendingDs?: unknown } })
    .store;
  if (hasPending(store?.pendingStructs) || hasPending(store?.pendingDs)) {
    throw new BranchPeerIntegrationError(operation, journalIds);
  }
}

function hasPending(value: unknown): boolean {
  if (value == null) return false;
  if (value instanceof Uint8Array) return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}
