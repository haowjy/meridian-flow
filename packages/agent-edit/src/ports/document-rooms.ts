import type { DocumentRemovalRecord, DocumentRoom } from "@meridian/contracts/protocol";
import type { RoomDocs, StoredEdit } from "@meridian/document-model";
import type { DocumentRooms, RoomOrigin } from "@meridian/document-model/rooms";
import type { PMNode } from "@meridian/markup";
import type { StoredDelta } from "../tool/delta.js";
import type { MutationActor, WriteContext } from "../tool/types.js";

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

/** A call's copy of the room it reads, named by the room. The caller frees `docs`. */
export interface AgentRoomRead {
  room: DocumentRoom;
  docs: RoomDocs;
}

/**
 * What a write did, as the host stores it beside the write's batch (`document_edit_parts`): the
 * write's identity and author, the room it merged into, and its `delta`, the blocks it changed
 * before and after there, which the card and the model's list of its edits read, and the write as
 * an edit of the one Undo rule (design §2), which every inverse of it runs on.
 */
export interface AgentWriteRecord {
  documentId: string;
  /** Live, or the chat's draft fork: where the model's undo and revert of this write run. */
  room: DocumentRoom;
  /**
   * The write as one edit of design §2's Undo rule, as it landed in the call's copy: the turn
   * Undo and the model's undo and revert take it back (`takeBack`).
   */
  edit: StoredEdit;
  /** The write's ordinal in its thread, rendered `e<N>`. */
  wId: number;
  toolCallId?: string;
  threadId: string;
  turnId: string | null;
  authoringResponseId?: string;
  actor: MutationActor;
  delta: StoredDelta | null;
}

/**
 * agent-edit's documents on Loro (design §5): `readRoom` is the one way a call gets a document to
 * render, plan from or record, and `save` the one way a write lands.
 *
 * A write plans on a view of `docs` at the frontier the model read (`RoomDocs.at`), lowers onto it
 * with `applyOps`, and saves the view's update as one envelope batch, so it merges into Live or the
 * draft's fork as an offline peer's edit would.
 */
export interface AgentEditRooms {
  /**
   * A private copy of the room this call reads `documentId` from: a Draft chat's draft fork, from
   * its first read (a fork with nothing stored reads as Live, design §2), else Live. A document
   * with no state yet reads empty. Rejects with `DocumentNotFoundError` when the document is
   * missing.
   */
  readRoom(documentId: string, context: WriteContext): Promise<AgentRoomRead>;

  /**
   * Store one write's batch, and its record, in the host's command: its docs' snapshots and the
   * record in the command's transaction, the import into the room after it commits.
   */
  save(
    room: DocumentRoom,
    batch: Uint8Array,
    record: AgentWriteRecord,
    context: WriteContext,
  ): Promise<void>;
}

/** What a host supplies to run agent-edit over its `DocumentRooms`. */
export interface AgentEditRoomsHost<Tx> {
  /**
   * The room a read of `documentId` goes to for this call's chat: the draft's fork room for a
   * Draft chat, whether or not the draft has written there, and the Live room for a Live chat or a
   * document only the draft holds. Never "does the fork exist".
   */
  roomFor(documentId: string, context: WriteContext): Promise<DocumentRoom>;
  /** The transaction of the command this call runs in. */
  transaction(): Tx;
  /** The origin saves are imported under (`server:turn:<id>`), never an author. */
  origin: RoomOrigin;
  /** Store a write's record in `tx`, beside its committed batch: the record says all an inverse needs. */
  recordWrite(tx: Tx, record: AgentWriteRecord, context: WriteContext): Promise<void>;
}

export function agentEditRooms<Tx>(
  rooms: DocumentRooms<Tx>,
  host: AgentEditRoomsHost<Tx>,
): AgentEditRooms {
  return {
    async readRoom(documentId, context) {
      const room = await host.roomFor(documentId, context);
      return { room, docs: await rooms.read(room) };
    },
    async save(room, batch, record, context) {
      const tx = host.transaction();
      await rooms.commit(tx, room, batch, host.origin);
      await host.recordWrite(tx, record, context);
    },
  };
}

/** One cut of a document as agent-edit rendered it. */
export interface DocumentCut {
  /** `encodeRoomVersion` of the copy the cut was read from. */
  version: Uint8Array;
  /** Its top-level blocks, with ids. */
  blocks: readonly PMNode[];
}
