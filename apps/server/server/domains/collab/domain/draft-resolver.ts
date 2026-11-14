/** Draft resolution: which draft a thread reads, never its content. */

import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DraftSnapshot } from "./draft-store.js";

/** A resolved draft's identity and state as its row was read; no content. */
export type ResolvedDraft = Pick<DraftSnapshot, "draftId" | "status" | "lifecycle" | "seed">;

export class DraftNotFoundError extends Error {
  readonly documentId: DocumentId;
  readonly threadId: ThreadId;

  constructor(documentId: DocumentId, threadId: ThreadId) {
    super(`No active Work draft exists for document ${documentId} and thread ${threadId}`);
    this.name = "DraftNotFoundError";
    this.documentId = documentId;
    this.threadId = threadId;
  }
}

export class DraftCorruptError extends Error {
  readonly draftId: string;
  readonly documentId: DocumentId;

  constructor(input: { draftId: string; documentId: DocumentId; cause?: unknown }) {
    super(
      `Draft ${input.draftId} for document ${input.documentId} has missing or undecodable Yjs state`,
      {
        cause: input.cause,
      },
    );
    this.name = "DraftCorruptError";
    this.draftId = input.draftId;
    this.documentId = input.documentId;
  }
}
