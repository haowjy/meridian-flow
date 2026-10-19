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
  /** The room the rows append into; null records no frontier (a document this save creates). */
  room: string | null;
  /**
   * The room's committed state before the kept rows, and with them: what the save's receipts,
   * commit-time detection and recorded frontier read.
   */
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
 * A host's prepared write of a save's kept entries, owned by the caller: nothing is persisted
 * until `persist` runs inside the caller's commit scope; `transfer` hands the write to the host
 * once that scope completed, and the host installs it (a live host delivers it to open
 * editors) when the enclosing root transaction commits, never before, or at once when there is
 * none; `dispose` drops it on any unwind. `persist` throws when the host's base moved since
 * preparing; the caller then disposes this write and prepares again.
 */
export interface StagedWriteCommit {
  kind: "write";
  persist(): Promise<void>;
  transfer(): void;
  dispose(): void;
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
 * A host's documents (live or draft) as agent-edit reaches them: `readRoom` is the one way a
 * call gets a document to render, plan from or record, and `prepareSave` the one way any write
 * lands, a reply's or one outside a reply alike. Neither serializes against other callers.
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

  /**
   * One save of a scope's entries, reconciled against its cut on the current room and prepared
   * without touching the host until `persist`. A document that doesn't exist yet saves onto an
   * empty one.
   */
  prepareSave(
    input: StagedRoomEntries & { docId: string; access?: DocumentAccess },
  ): Promise<StagedWriteSaveResult>;

  /**
   * Optional origin-aware description of the updates present in `doc` (the save's before
   * state) that `baselineDoc` (the view the writes planned on) doesn't contain: containment is
   * the only skip. Hosts that omit it have the whole delta treated as the writer's.
   */
  concurrentUpdatesSince?(input: {
    docId: string;
    doc: Y.Doc;
    baselineDoc?: Y.Doc;
    sinceStateVector: Uint8Array;
    reportingCut?: Uint8Array;
    access?: DocumentAccess;
  }): Promise<ConcurrentUpdate[]>;
}

/** How a caller reaches a host document. */
export interface DocumentAccess {
  /**
   * The thread peer a draft-mode call is bound to (`InteractionContext.peerDraftId`): the host
   * reads and saves exactly its Work draft and never provisions another.
   */
  pinnedDraftId?: string;
}
