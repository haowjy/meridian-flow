/** Thread-peer branch resolution port for agent tool document views. */

import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";

export interface BranchResolver {
  /**
   * Returns the active thread-peer branch for this (document, thread).
   *
   * Throws BranchNotFoundError if no active branch exists.
   * Throws BranchCorruptError if snapshot is missing or undecodable.
   * Throws StaleDocumentSchemaError if persisted branch state is behind the running schema.
   */
  resolveThreadBranch(documentId: DocumentId, threadId: ThreadId): Promise<BranchState>;
}

export type BranchState = {
  branchId: string;
  doc: Y.Doc;
  generation: number;
};

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

export function isBranchNotFoundError(cause: unknown): cause is BranchNotFoundError {
  return cause instanceof BranchNotFoundError;
}

export class BranchCorruptError extends Error {
  readonly branchId: string;
  readonly documentId: DocumentId;
  readonly threadId: ThreadId;

  constructor(input: {
    branchId: string;
    documentId: DocumentId;
    threadId: ThreadId;
    cause?: unknown;
  }) {
    super(
      `Branch ${input.branchId} for document ${input.documentId} and thread ${input.threadId} ` +
        "has missing or undecodable Yjs state",
      { cause: input.cause },
    );
    this.name = "BranchCorruptError";
    this.branchId = input.branchId;
    this.documentId = input.documentId;
    this.threadId = input.threadId;
  }
}

export function isBranchCorruptError(cause: unknown): cause is BranchCorruptError {
  return cause instanceof BranchCorruptError;
}
