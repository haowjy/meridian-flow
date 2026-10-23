import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type * as Y from "yjs";
import type { ConcurrentUpdate } from "../apply/types.js";
import type { BlockOriginMap } from "../model/block-hash.js";

/** Why a retired thread peer's staged writes did not land: a Discard, or the document's removal. */
export type RetiredWriteReason = Exclude<
  StagedWriteRejectionReason,
  "discard" | "inverse" | "integration"
>;

/**
 * Where a reply's edit scope began writing into a document's room: the room copy's
 * Yjs snapshot (`Y.encodeSnapshotV2`, state vector and delete set) at the
 * scope's first stage. Reconcile reads only what inverted since it.
 */
export interface StagedCut {
  snapshot: Uint8Array;
}

/**
 * Why a staged write did not land. `discarded_*` come from a Discard that retired the thread's peer:
 * the whole branch, this created document, or this edited document's text. `removed` is the
 * document's removal, with its record; null when a removal closed the draft but the document
 * stands again (a Work Restore).
 */
export type StagedWriteRejectionReason =
  | "discard"
  | "inverse"
  | "integration"
  | "discarded_draft"
  | "discarded_document"
  | "discarded_edit"
  | { removed: DocumentRemovalRecord | null };

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
 * label for the room the copy was read from (null records no frontier).
 */
export interface RoomRead extends StagedReconcile {
  doc: Y.Doc;
  room: string | null;
}

/** A document's state before a save's kept rows, and with them. */
export interface SaveCut {
  beforeState: Uint8Array;
  afterState: Uint8Array;
}

/** A save of one scope's entries: the kept and refused ones, and where they went. */
export interface StagedWriteSaveResult extends StagedReconcile {
  /** The room the rows append into; null records no frontier when the host cannot name it. */
  room: string | null;
  /** Immutable address context for every cut reconstructed from this save. */
  blockOrigins?: BlockOriginMap;
  /**
   * The host's prepared write, always present. `no-effect` says there is nothing to persist,
   * and is valid only with no kept entries; the caller refuses it otherwise rather than
   * certify writes nobody stored.
   */
  write: StagedWriteCommit | { kind: "no-effect" };
}

/**
 * What a save requires of its document, judged by the host inside the append under the
 * document's lock, on the state the rows would follow (the cut's `beforeState`), before
 * anything is written. False refuses the save: `persist` rejects with SavePreconditionRefused.
 */
export type SavePrecondition = (beforeState: Uint8Array) => boolean;

/** A save whose precondition its document failed under the lock: nothing was appended. */
export class SavePreconditionRefused extends Error {
  constructor(readonly docId: string) {
    super(`Save precondition refused on ${docId}`);
    this.name = "SavePreconditionRefused";
  }
}

/**
 * A host's prepared write of a save's kept entries, owned by the caller: nothing is persisted
 * until `persist` runs inside the caller's commit scope; `transfer` hands the write to the host
 * once that scope completed, and the host installs it (a live host delivers it to open
 * editors) when the enclosing root transaction commits, never before, or at once when there is
 * none; `dispose` drops it on any unwind.
 *
 * `persist` resolves the save's only cut: the document as the host's serialization of the
 * append (its document lock) found it, and with the kept rows. Someone else's rows that landed
 * between preparing and appending are in its `beforeState`, so the report names what the rows
 * swept of them; the rows themselves are Yjs updates and land the same either way.
 */
export interface StagedWriteCommit {
  kind: "write";
  persist(): Promise<SaveCut>;
  transfer(): void;
  dispose(): void;
}

/**
 * A room read whose bound draft a writer's Discard took. The host names which Discard, so the
 * call is refused with that reason instead of failing.
 */
export class DocumentAccessLostError extends Error {
  constructor(
    readonly reason: RetiredWriteReason,
    options?: ErrorOptions,
  ) {
    super(`Document access lost: ${reason}`, options);
    this.name = "DocumentAccessLostError";
  }
}

export class DocumentNotFoundError extends Error {
  readonly docId: string;
  /** The document's removal record, when it is missing because it was removed. */
  readonly removal?: DocumentRemovalRecord;

  constructor(
    docId: string,
    message = `Document not found: ${docId}`,
    options: { removal?: DocumentRemovalRecord } = {},
  ) {
    super(message);
    this.name = "DocumentNotFoundError";
    this.docId = docId;
    if (options.removal) this.removal = options.removal;
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
   * empty one. `precondition` is judged inside the append, never before it.
   */
  prepareSave(
    input: StagedRoomEntries & {
      docId: string;
      access?: DocumentAccess;
      precondition?: SavePrecondition;
    },
  ): Promise<StagedWriteSaveResult>;

  /**
   * Optional origin-aware description of the updates present in `doc` (the save's before
   * state, frozen: the host reports only what it contains) that `baselineDoc` (the view the
   * writes planned on) doesn't contain: containment is the only skip. Hosts that omit it have
   * the whole delta treated as the writer's.
   */
  concurrentUpdatesSince?(input: {
    docId: string;
    doc: Y.Doc;
    baselineDoc?: Y.Doc;
    sinceStateVector: Uint8Array;
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
  /**
   * The Work draft a draft read bound to no peer reads, as the caller already resolved it; a
   * host resolves the thread's Work draft itself when this is absent.
   */
  workDraftId?: string;
}
