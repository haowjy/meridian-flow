import type * as Y from "yjs";

export class DocumentNotFoundError extends Error {
  readonly docId: string;

  constructor(docId: string, message = `Document not found: ${docId}`) {
    super(message);
    this.name = "DocumentNotFoundError";
    this.docId = docId;
  }
}

export function isDocumentNotFoundError(cause: unknown): cause is DocumentNotFoundError {
  return cause instanceof DocumentNotFoundError;
}

/**
 * Exclusive access to live Y.Docs — one mutator at a time per document.
 * Server adapters use KeyedMutex + Hocuspocus; desktop uses a process-level lock.
 */
export interface DocumentCoordinator {
  /**
   * Acquire exclusive access to a document's live Y.Doc for the duration of fn.
   * Serializes concurrent callers for the same docId; different documents run concurrently.
   * Rejects with DocumentNotFoundError when the document is missing; other
   * rejections are runtime failures and surface as retryable internal errors.
   */
  withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T>;

  /**
   * Replay persisted-but-not-applied updates on startup or recovery.
   * Idempotent: safe to call multiple times; applies only updates missing from the live doc.
   */
  recover(docId: string): Promise<void>;
}
