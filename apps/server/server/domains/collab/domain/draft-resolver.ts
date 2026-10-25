/** Thread-peer draft resolution port: which draft a thread reads, never its content. */

import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DraftSnapshot } from "./draft-store.js";

export interface DraftResolver {
  /**
   * The active thread-peer draft for this (document, thread), as metadata: its content is read
   * through the coordinator, in one observation with the row it belongs to.
   *
   * Throws DraftNotFoundError if no active draft exists.
   */
  resolveThreadDraft(documentId: DocumentId, threadId: ThreadId): Promise<ResolvedDraft>;
}

/** A resolved draft's identity and state as its row was read; no content. */
export type ResolvedDraft = Pick<DraftSnapshot, "draftId" | "status" | "lifecycle" | "seed">;

export class DraftNotFoundError extends Error {
  readonly documentId: DocumentId;
  readonly threadId: ThreadId;

  constructor(documentId: DocumentId, threadId: ThreadId) {
    super(`No active thread-peer draft exists for document ${documentId} and thread ${threadId}`);
    this.name = "DraftNotFoundError";
    this.documentId = documentId;
    this.threadId = threadId;
  }
}

export class DraftCorruptError extends Error {
  readonly draftId: string;
  readonly documentId: DocumentId;
  readonly threadId: ThreadId | undefined;

  constructor(input: {
    draftId: string;
    documentId: DocumentId;
    threadId?: ThreadId;
    cause?: unknown;
  }) {
    super(
      `Draft ${input.draftId} for document ${input.documentId}${input.threadId ? ` and thread ${input.threadId}` : ""} ` +
        "has missing or undecodable Yjs state",
      { cause: input.cause },
    );
    this.name = "DraftCorruptError";
    this.draftId = input.draftId;
    this.documentId = input.documentId;
    this.threadId = input.threadId;
  }
}
