import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type * as Y from "yjs";
import type { ConcurrentUpdate } from "../apply/types.js";
import type { BlockOriginMap } from "../model/block-hash.js";
import type { JournalBatchAppendEntry } from "./update-journal.js";

/**
 * Why a write did not land. `discarded_*` come from a Discard: the whole branch, this created
 * document, or this edited document's text. `removed` is the document's removal, with its
 * record; null when a removal closed the draft but the document stands again (a Work Restore).
 */
export type WriteRefusalReason =
  | "discarded_draft"
  | "discarded_document"
  | "discarded_edit"
  | { removed: DocumentRemovalRecord | null };

/**
 * A call's copy of a document's room: private, gc-off, the room's committed state. The caller
 * owns `doc` and destroys it. `room` is the host's label for the room the copy was read from
 * (null records no frontier).
 */
export interface RoomRead {
  doc: Y.Doc;
  room: string | null;
  /** Journal high-water mark for `doc`, in the room's host-owned sequence. */
  position?: number;
}

/** A document's state before a save's kept rows, and with them. */
export interface SaveCut {
  beforeState: Uint8Array;
  afterState: Uint8Array;
  /** Journal high-water mark of `afterState`. */
  position?: number;
}

/** A save of one write's entries: where they go, prepared and not yet persisted. */
export interface PreparedSave {
  /** The room the rows append into; null records no frontier when the host cannot name it. */
  room: string | null;
  /** Immutable address context for every cut reconstructed from this save. */
  blockOrigins?: BlockOriginMap;
  /** The host's prepared write; `no-effect` says there is nothing to persist. */
  write: PreparedWrite | { kind: "no-effect" };
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
 * A host's prepared write of a save's entries, owned by the caller: nothing is persisted until
 * `persist` runs inside the caller's commit scope; `transfer` hands the write to the host once
 * that scope completed, and the host installs it (a live host delivers it to open editors) when
 * the enclosing root transaction commits, never before, or at once when there is none;
 * `dispose` drops it on any unwind.
 *
 * `persist` resolves the save's only cut: the document as the host's serialization of the
 * append (its document lock) found it, and with the kept rows. Someone else's rows that landed
 * between preparing and appending are in its `beforeState`, so the report names what the rows
 * swept of them; the rows themselves are Yjs updates and land the same either way.
 */
export interface PreparedWrite {
  kind: "write";
  persist(): Promise<SaveCut>;
  transfer(): void;
  dispose(): void;
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
export interface ConcurrentUpdatesInput {
  docId: string;
  doc: Y.Doc;
  baselineDoc?: Y.Doc;
  /** Exclusive observed and inclusive rendered journal bounds. */
  after: number;
  through: number;
  /** Optional live interval projected into a draft's revision-0 cut. */
  attributionBridge?: import("../frontier.js").SeedAttributionBridge;
  access?: DocumentAccess;
}

export interface DocumentCoordinator {
  /** A private copy of the room's committed state, named by the room it was read from. Rejects with DocumentNotFoundError when the document is missing. */
  readRoom(docId: string, access?: DocumentAccess): Promise<RoomRead>;

  /**
   * One save of a write's entries, prepared without touching the host until `persist`. A
   * document that doesn't exist yet saves onto an empty one. `precondition` is judged inside
   * the append, never before it.
   */
  prepareSave(input: {
    docId: string;
    entries: readonly JournalBatchAppendEntry[];
    access?: DocumentAccess;
    precondition?: SavePrecondition;
  }): Promise<PreparedSave>;

  /** One bounded, origin-aware lookup for the model-facing concurrent-change account. */
  concurrentUpdatesForReport?(input: ConcurrentUpdatesInput): Promise<ConcurrentUpdate[]>;
}

/** How a caller reaches a host document. */
export interface DocumentAccess {
  /** The Work draft a draft call reads and saves, as the host ensured it; live when absent. */
  workDraftId?: string;
}
