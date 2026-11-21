import type { DocumentRoom } from "@meridian/contracts/protocol";
import type { RoomDocs } from "@meridian/document-model";
import type { DocumentRooms, RoomOrigin } from "@meridian/document-model/rooms";

/** A call's copy of the room it reads, named by the room. The caller frees `docs`. */
export interface AgentRoomRead {
  room: DocumentRoom;
  docs: RoomDocs;
}

/**
 * agent-edit's documents on Loro (design §5): `readRoom` is the one way a call gets a document to
 * render, plan from or record, and `save` the one way a write lands. It replaces
 * `DocumentCoordinator` when agent-edit moves off Yjs (phase 1d); until then nothing calls it.
 *
 * A write plans on a view of `docs` at the frontier the model read (`forkAt` per doc), lowers onto
 * it with `applyOps`, and saves the view's update as one envelope batch, so it merges into Live or
 * the draft's fork as an offline peer's edit would.
 */
export interface AgentEditRooms {
  /**
   * A private copy of the room this call reads `documentId` from: the chat's draft fork when one
   * exists, else Live (a Draft chat with no fork yet reads Live). Rejects with
   * `DocumentNotFoundError` when the document is missing.
   */
  readRoom(documentId: string): Promise<AgentRoomRead>;

  /**
   * Store one write's batch in the host's command: its docs' snapshots in the command's
   * transaction, the import into the room after it commits.
   */
  save(room: DocumentRoom, batch: Uint8Array): Promise<void>;
}

/** What a host supplies to run agent-edit over its `DocumentRooms`. */
export interface AgentEditRoomsHost<Tx> {
  /** The room a read of `documentId` goes to for this call's chat. */
  roomFor(documentId: string): Promise<DocumentRoom>;
  /** The transaction of the command this call runs in. */
  transaction(): Tx;
  /** The origin saves are imported under (`server:turn:<id>`), never an author. */
  origin: RoomOrigin;
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
    save: (room, batch) => rooms.commit(host.transaction(), room, batch, host.origin),
  };
}
