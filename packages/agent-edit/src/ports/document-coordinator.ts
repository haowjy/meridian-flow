import type * as Y from "yjs";
import type { ConcurrentUpdate } from "../apply/types.js";

export const hostSaveLeaseBrand: unique symbol = Symbol("HostSaveLease");
export interface HostSaveLease {
  readonly [hostSaveLeaseBrand]: true;
}
export type DiscardedWriteReason = Extract<StagedWriteRejectionReason, `discarded_${string}`>;

/** The helper's authority base, independent of the generations its staged writes name. */
export interface StagedHelperCut {
  generation: number;
  state: Uint8Array;
}

/**
 * Why a staged write did not land. `discarded_*` come from a Discard that retired the thread's peer:
 * the whole draft, this created document, or this edited document's text.
 */
export type StagedWriteRejectionReason =
  | "discard"
  | "inverse"
  | "integration"
  | "discarded_draft"
  | "discarded_document"
  | "discarded_edit";

export interface StagedWriteReplayResult {
  rejectedWrites?: readonly { writeId: string; reason: StagedWriteRejectionReason }[];
  keptEntries: readonly import("./update-journal.js").JournalBatchAppendEntry[];
  helperState: Uint8Array;
  helperCut: StagedHelperCut;
  beforeState: Uint8Array;
}

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
  /** Rebuild/replay staged writes under the host's existing generation lock.
   * The host admits only whole logical writes and returns an isolated accepted replay result.
   * commit=true journals survivors in the ambient response transaction.
   */
  withStagedWrites?(input: {
    docId: string;
    sourceDoc: Y.Doc;
    helperCut: StagedHelperCut;
    entries: readonly import("./update-journal.js").JournalBatchAppendEntry[];
    commit: boolean;
    access?: DocumentLockOptions;
  }): Promise<StagedWriteReplayResult>;

  /** Immutable host generation bound to this canonical document, when supported. */
  documentAuthority?(doc: Y.Doc): import("./update-journal.js").JournalAuthority;
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
    reportingCut?: Uint8Array;
    access?: DocumentLockOptions;
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
  /**
   * The host branch a staged thread-peer write was pinned to (`InteractionContext.branchId`):
   * the coordinator resolves exactly this one and never provisions another.
   */
  pinnedBranchId?: string;
  /**
   * A host lock the caller already holds over this document (a reply's save takes its
   * branches' locks before its transaction); the coordinator runs under it instead of
   * acquiring its own. Opaque to this package.
   */
  lease?: HostSaveLease;
}
