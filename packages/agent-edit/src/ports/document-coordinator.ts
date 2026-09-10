import type * as Y from "yjs";
import type { ConcurrentUpdate } from "../apply/types.js";

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
 * Serializes port callers against the host-owned canonical Y.Doc (live or branch).
 * Mutations through other transports require the host's separate concurrency fence.
 */
export interface DocumentCoordinator {
  /**
   * Acquire coordinator access to a document's canonical Y.Doc for the duration of fn.
   * Serializes concurrent callers for the same docId; different documents run concurrently.
   * Rejects with DocumentNotFoundError when the document is missing; other
   * rejections are runtime failures and surface as retryable internal errors.
   */
  withDocument<T>(
    docId: string,
    fn: (doc: Y.Doc) => Promise<T>,
    options?: DocumentLockOptions,
  ): Promise<T>;

  /**
   * Optional origin-aware description of the updates currently present in the
   * coordinated doc after `sinceStateVector`. Generic live-doc adapters omit this
   * and callers treat the delta as human-origin for backward compatibility.
   */
  concurrentUpdatesSince?(input: {
    docId: string;
    doc: Y.Doc;
    baselineDoc?: Y.Doc;
    sinceStateVector: Uint8Array;
    afterJournalId?: number;
    liveJournalSeq?: number;
    attemptId?: string;
  }): Promise<ConcurrentUpdate[]>;

  /**
   * Replay persisted-but-not-applied updates on startup or recovery.
   * Idempotent: safe to call multiple times; applies only updates missing from the coordinated doc.
   */
  recover(docId: string): Promise<void>;
}

export interface DocumentLockOptions {
  /** Maximum wait to acquire the lock. Callback duration is not timed. */
  timeoutMs?: number;
  signal?: AbortSignal;
}
