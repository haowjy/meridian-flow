/** Thread-peer branch resolution port: which branch a thread reads, never its content. */

import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { BranchSnapshot } from "./branch-store.js";

export interface BranchResolver {
  /**
   * The active thread-peer branch for this (document, thread), as metadata: its content is read
   * through the coordinator, in one observation with the row it belongs to.
   *
   * Throws BranchNotFoundError if no active branch exists.
   */
  resolveThreadBranch(documentId: DocumentId, threadId: ThreadId): Promise<ResolvedBranch>;
}

/** A resolved branch's identity and state as its row was read; no content. */
export type ResolvedBranch = Pick<
  BranchSnapshot,
  "branchId" | "generation" | "status" | "lifecycle"
>;

export class BranchNotFoundError extends Error {
  readonly documentId: DocumentId;
  readonly threadId: ThreadId;

  constructor(documentId: DocumentId, threadId: ThreadId) {
    super(`No active thread-peer branch exists for document ${documentId} and thread ${threadId}`);
    this.name = "BranchNotFoundError";
    this.documentId = documentId;
    this.threadId = threadId;
  }
}

export class BranchCorruptError extends Error {
  readonly branchId: string;
  readonly documentId: DocumentId;
  readonly threadId: ThreadId | undefined;
  readonly generation: number | undefined;

  constructor(input: {
    branchId: string;
    documentId: DocumentId;
    threadId?: ThreadId;
    generation?: number;
    cause?: unknown;
  }) {
    super(
      `Branch ${input.branchId} for document ${input.documentId}${input.threadId ? ` and thread ${input.threadId}` : ""} ` +
        "has missing or undecodable Yjs state",
      { cause: input.cause },
    );
    this.name = "BranchCorruptError";
    this.branchId = input.branchId;
    this.documentId = input.documentId;
    this.threadId = input.threadId;
    this.generation = input.generation;
  }
}
