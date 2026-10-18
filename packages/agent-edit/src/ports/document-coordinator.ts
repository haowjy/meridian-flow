import type * as Y from "yjs";
import type { ConcurrentUpdate } from "../apply/types.js";

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

/** A response's staged entries for one document, replayed against an explicit helper cut. */
export interface StagedWriteReplayInput {
  docId: string;
  sourceDoc: Y.Doc;
  helperCut: StagedHelperCut;
  entries: readonly import("./update-journal.js").JournalBatchAppendEntry[];
  access?: DocumentAccess;
}

/** A replay for reading: what the host would keep, and the helper it rebuilt. Writes nothing. */
export interface StagedWriteReplayResult {
  rejectedWrites?: readonly { writeId: string; reason: StagedWriteRejectionReason }[];
  keptEntries: readonly import("./update-journal.js").JournalBatchAppendEntry[];
  helperState: Uint8Array;
  helperCut: StagedHelperCut;
  beforeState: Uint8Array;
}

/**
 * A replay for saving: the read result and the host's prepared write of the kept entries,
 * always present. `no-effect` says there is nothing to persist, and is valid only with no
 * kept entries; the caller refuses it otherwise rather than certify writes nobody stored.
 */
export interface StagedWriteSaveResult extends StagedWriteReplayResult {
  write: StagedWriteCommit | { kind: "no-effect" };
}

/**
 * A host's prepared write of a save's kept entries, owned by the caller's attempt: nothing is
 * persisted until `persist` runs inside the caller's commit scope; `transfer` hands the write
 * to the host once that attempt completed, and the host installs it when the enclosing root
 * transaction commits (never before); `dispose` drops it on any unwind. `persist` throws when
 * the host's base moved since the replay; the caller then disposes this write and replays.
 */
export interface StagedWriteCommit {
  kind: "write";
  persist(): Promise<void>;
  transfer(): void;
  dispose(): void;
}

/**
 * A host that stages a response's writes on private candidates (a branch host). A read replays;
 * a save also prepares the write. Both are pure with respect to the host until `persist`.
 */
export interface StagedWriteHost {
  replay(input: StagedWriteReplayInput): Promise<StagedWriteReplayResult>;
  prepareSave(input: StagedWriteReplayInput): Promise<StagedWriteSaveResult>;
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
 * Port callers' access to the host-owned canonical Y.Doc (live or branch). Callers must not
 * rely on mutual exclusion: each host decides how a mutation commits (a live host serializes
 * callers; a branch host runs them on private candidates and commits an ordinary CRDT write as
 * an unfenced append, while an exact peer catch-up or rewrite commits only at the revision it
 * captured, so a staged save can still miss that revision).
 */
export interface DocumentCoordinator {
  /**
   * Staged response writes, for a host that keeps them on private candidates. The host admits
   * only whole logical writes and returns an isolated result; nothing persists until the
   * caller runs a save's `write.persist`.
   */
  stagedWrites?: StagedWriteHost;

  /** Immutable host generation bound to this canonical document, when supported. */
  documentAuthority?(doc: Y.Doc): import("./update-journal.js").JournalAuthority;
  /**
   * Runs `fn` on the host's document for the duration of the call. Its mutations commit
   * atomically or refuse; callers must not rely on mutual exclusion with other callers.
   * Rejects with DocumentNotFoundError when the document is missing; other
   * rejections are runtime failures and surface as retryable internal errors.
   */
  withDocument<T>(
    docId: string,
    fn: (doc: Y.Doc) => Promise<T>,
    options?: DocumentAccess,
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
    access?: DocumentAccess;
  }): Promise<ConcurrentUpdate[]>;

  /**
   * Replay persisted-but-not-applied updates on startup or recovery.
   * Idempotent: safe to call multiple times; applies only updates missing from the coordinated doc.
   */
  recover(docId: string): Promise<void>;
}

/** How a caller reaches a host document. */
export interface DocumentAccess {
  /**
   * A live host only: the maximum wait for its per-document serialization. Callback duration
   * is not timed; a branch host, which serializes nothing, ignores it.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * The host branch a staged thread-peer write was pinned to (`InteractionContext.branchId`):
   * the coordinator resolves exactly this one and never provisions another.
   */
  pinnedBranchId?: string;
}
