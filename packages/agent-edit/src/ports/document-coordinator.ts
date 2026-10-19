import type * as Y from "yjs";
import type { ConcurrentUpdate } from "../apply/types.js";

export type DiscardedWriteReason = Extract<StagedWriteRejectionReason, `discarded_${string}`>;

/**
 * Where a reply's edit scope began writing into a document's room: the room copy's
 * host generation and Yjs snapshot (`Y.encodeSnapshotV2`, state vector and delete set) at the
 * scope's first stage. Reconcile reads only what retired or inverted since it.
 */
export interface StagedCut {
  generation: number;
  snapshot: Uint8Array;
}

/**
 * Why a staged write did not land. `discarded_*` come from a Discard that retired the thread's peer:
 * the whole branch, this created document, or this edited document's text.
 */
export type StagedWriteRejectionReason =
  | "discard"
  | "inverse"
  | "integration"
  | "discarded_draft"
  | "discarded_document"
  | "discarded_edit";

/** One edit scope's staged entries for one document, with the cut the scope began at. */
export interface StagedRoomEntries {
  cut: StagedCut;
  entries: readonly import("./update-journal.js").JournalBatchAppendEntry[];
}

/** The staged writes that survive reconcile, and the refused ones, by `mutation.writeId`. */
export interface StagedReconcile {
  kept: readonly string[];
  rejected: readonly { writeId: string; reason: StagedWriteRejectionReason }[];
}

/**
 * A call's copy of a document's room: private, gc-off, the room's committed state with the
 * scope's kept entries applied. The caller owns `doc` and destroys it. `room` is the host's
 * label for the room the copy was read from (null records no frontier); `generation` is the
 * host generation a scope cut taken from this copy names.
 */
export interface RoomRead extends StagedReconcile {
  doc: Y.Doc;
  room: string | null;
  generation: number;
}

/** A save of one scope's entries: the kept and refused ones, and where they went. */
export interface StagedWriteSaveResult extends StagedReconcile {
  /** The room the rows append into. */
  room: string | null;
  /** The room's committed state before the kept rows, and with them. */
  beforeState: Uint8Array;
  afterState: Uint8Array;
  /**
   * The host's prepared write, always present. `no-effect` says there is nothing to persist,
   * and is valid only with no kept entries; the caller refuses it otherwise rather than
   * certify writes nobody stored.
   */
  write: StagedWriteCommit | { kind: "no-effect" };
}

/**
 * A host's prepared write of a save's kept entries, owned by the caller's attempt: nothing is
 * persisted until `persist` runs inside the caller's commit scope; `transfer` hands the write
 * to the host once that attempt completed, and the host installs it when the enclosing root
 * transaction commits (never before); `dispose` drops it on any unwind. `persist` throws when
 * the host's base moved since preparing; the caller then disposes this write and prepares again.
 */
export interface StagedWriteCommit {
  kind: "write";
  persist(): Promise<void>;
  transfer(): void;
  dispose(): void;
}

/**
 * A host that saves a response's staged writes itself (a draft host): it reconciles them
 * against the scope's cut on the current room and prepares their rows. Pure with respect to
 * the host until `persist`.
 */
export interface StagedWriteHost {
  prepareSave(
    input: StagedRoomEntries & { docId: string; access?: DocumentAccess },
  ): Promise<StagedWriteSaveResult>;
}

/**
 * A room read whose bound draft a writer's Discard took. The host names which Discard, so the
 * call is refused with that reason instead of failing.
 */
export class DocumentAccessLostError extends Error {
  constructor(
    readonly reason: DiscardedWriteReason,
    options?: ErrorOptions,
  ) {
    super(`Document access lost: ${reason}`, options);
    this.name = "DocumentAccessLostError";
  }
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
 * Port callers' access to the host-owned canonical Y.Doc (live or draft). `readRoom` is the one
 * way a call gets a document to render, plan from or record: a private copy, read without
 * serializing against other callers. `withDocument` is a commit door: callers must not rely on
 * mutual exclusion (a live host serializes callers; a draft host saves through `stagedWrites`).
 */
export interface DocumentCoordinator {
  /**
   * A private copy of the room's committed state with `staged`'s surviving entries applied,
   * named by the room it was read from. Rejects with DocumentNotFoundError when the document
   * is missing.
   */
  readRoom(
    docId: string,
    staged: StagedRoomEntries | null,
    access?: DocumentAccess,
  ): Promise<RoomRead>;

  /** Staged response writes, for a host that saves them itself (a draft host). */
  stagedWrites?: StagedWriteHost;

  /** Immutable host generation bound to this canonical document, when supported. */
  documentAuthority?(doc: Y.Doc): import("./update-journal.js").JournalAuthority;
  /**
   * The room label of a document this host handed to `withDocument`, under its access: what a
   * save that committed into it records. Null when the host can't name it.
   */
  roomFor?(docId: string, doc: Y.Doc): string | null;
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
   * is not timed; a draft host, which serializes nothing, ignores it.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * The thread peer a draft-mode call is bound to (`InteractionContext.peerDraftId`): the host
   * reads and saves exactly its Work draft and never provisions another.
   */
  pinnedDraftId?: string;
}
