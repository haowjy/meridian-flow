import {
  type BlockRef,
  decodeUpdateForDependencies,
  deleteRanges,
  rangeCovers,
  suppliedRanges,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import * as Y from "yjs";
import type { BranchJournalRow, PublicationBlockChange } from "./branch-push-contracts.js";
import { documentDifference } from "./document-difference.js";

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

export function publicationBlockChanges(input: {
  model: YProsemirrorDocumentModel;
  beforeDoc: Y.Doc;
  afterDoc: Y.Doc;
  renderBlock?(doc: Y.Doc, block: BlockRef): string;
}): PublicationBlockChange[] {
  return documentDifference(input.beforeDoc, input.afterDoc, input.model)
    .flatMap((entry) => {
      if (entry.kind === "equal") return [];
      return [
        {
          blockId: entry.kind === "delete" ? entry.live.id : entry.draft.id,
          beforeBlockIdentity:
            entry.kind === "insert"
              ? null
              : input.model.getCanonicalBlockIdentity(entry.live.block),
          afterBlockIdentity:
            entry.kind === "delete"
              ? null
              : input.model.getCanonicalBlockIdentity(entry.draft.block),
          beforeText:
            entry.kind === "insert"
              ? null
              : (input.renderBlock?.(input.beforeDoc, entry.live.block) ?? entry.live.text),
          afterText:
            entry.kind === "delete"
              ? null
              : (input.renderBlock?.(input.afterDoc, entry.draft.block) ?? entry.draft.text),
        },
      ];
    })
    .sort((a, b) => a.blockId.localeCompare(b.blockId));
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
