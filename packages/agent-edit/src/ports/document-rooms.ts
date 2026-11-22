import type { DocumentRoom } from "@meridian/contracts/protocol";
import type { RoomDocs } from "@meridian/document-model";
import type { DocumentRooms, RoomOrigin } from "@meridian/document-model/rooms";
import type { PMNode } from "@meridian/markup";
import type { HolderLinkScope } from "@meridian/markup/links";
import type { StoredDelta } from "../content-merge/stands.js";
import type { MutationActor, WriteStatus } from "../tool/types.js";
import type { ModelInverseCommand } from "./document-edits.js";
import type { DocumentLinksPort } from "./document-links.js";

/** A call's copy of the room it reads, named by the room. The caller frees `docs`. */
export interface AgentRoomRead {
  room: DocumentRoom;
  docs: RoomDocs;
}

/**
 * What a write did, as the host stores it beside the write's batch (`document_edit_parts`): the
 * write's identity and author, and its `delta`, the blocks it changed before and after in the room
 * it merged into. The delta is the whole record: turn Undo and the model's list of its edits read
 * it against the text by content, never by CRDT ids (design §5, "Receipts").
 */
export interface AgentWriteRecord {
  documentId: string;
  /** Stable write id (`turn:<turn>:tool:<call>`), and its ordinal, rendered `e<N>`. */
  writeId: string;
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
   * A private copy of the room this call reads `documentId` from: the chat's draft fork when one
   * exists, else Live (a Draft chat with no fork yet reads Live). A document with no state yet
   * reads empty. Rejects with `DocumentNotFoundError` when the document is missing.
   */
  readRoom(documentId: string): Promise<AgentRoomRead>;

  /**
   * Store one write's batch, and its record, in the host's command: its docs' snapshots and the
   * record in the command's transaction, the import into the room after it commits.
   */
  save(room: DocumentRoom, batch: Uint8Array, record: AgentWriteRecord | null): Promise<void>;
}

/** What a host supplies to run agent-edit over its `DocumentRooms`. */
export interface AgentEditRoomsHost<Tx> {
  /** The room a read of `documentId` goes to for this call's chat. */
  roomFor(documentId: string): Promise<DocumentRoom>;
  /** The transaction of the command this call runs in. */
  transaction(): Tx;
  /** The origin saves are imported under (`server:turn:<id>`), never an author. */
  origin: RoomOrigin;
  /** Store a write's record in `tx`, beside its batch. */
  recordWrite(tx: Tx, record: AgentWriteRecord): Promise<void>;
}

export function agentEditRooms<Tx>(
  rooms: DocumentRooms<Tx>,
  host: AgentEditRoomsHost<Tx>,
): AgentEditRooms {
  return {
    async readRoom(documentId) {
      const room = await host.roomFor(documentId);
      return { room, docs: await rooms.read(room) };
    },
    async save(room, batch, record) {
      const tx = host.transaction();
      await rooms.commit(tx, room, batch, host.origin);
      if (record) await host.recordWrite(tx, record);
    },
  };
}

/**
 * The link port on Loro: the revision names a cut by its room version and the blocks it shows,
 * not a Yjs document.
 */
export type LoroLinksPort = Omit<DocumentLinksPort, "revision"> & {
  revision(cut: DocumentCut, scope: HolderLinkScope): string;
};

/** One cut of a document as agent-edit rendered it. */
export interface DocumentCut {
  /** `encodeRoomVersion` of the copy the cut was read from. */
  version: Uint8Array;
  /** Its top-level blocks, with ids. */
  blocks: readonly PMNode[];
}

/** The host's record of a document's AI edits and their inverses, on Loro. */
export interface LoroDocumentEdits {
  /** The model's list of its edits (`read` with `format: "edits"`). */
  read(request: { documentId: string; threadId: string }): Promise<{
    status: "success" | Exclude<WriteStatus, "success">;
    message: string;
  }>;
  /** The model's `undo` or `revert`: the host writes the inverse and says what it did. */
  execute(request: {
    documentId: string;
    threadId: string;
    command: ModelInverseCommand;
  }): Promise<
    | { status: Exclude<WriteStatus, "success">; message: string }
    | { status: "success"; message: string; writeId?: string }
  >;
}
