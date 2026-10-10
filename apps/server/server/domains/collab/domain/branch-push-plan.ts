/** Pure document materialization and integration primitives for branch pushes. */
import { createHash } from "node:crypto";
import { toDocHandle, type YProsemirrorDocumentModel } from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import type { PublicationBlockChange } from "./branch-push-contracts.js";

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
}): string {
  return createHash("sha256")
    .update(input.branchId)
    .update("\0")
    .update(String(input.generation))
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
