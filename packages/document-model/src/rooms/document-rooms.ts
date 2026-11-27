import type { DocumentRoom } from "@meridian/contracts/protocol";
import type { PeerId } from "../peer.js";
import type { RoomDocs } from "../room-docs.js";

export type RoomOrigin = string;

export interface RoomBatch {
  room: DocumentRoom;
  batch: Uint8Array;
  origin: RoomOrigin;
}

export interface RoomSync {
  version: Uint8Array;
  update: Uint8Array | null;
}

/**
 * The one door to a document room on the server (design §4). Every server read or write of a
 * document goes through it: the socket handler (`write`, `sync`, `subscribe`), commands, presses,
 * derivations, agent-edit and `./mf doc` (`read`, `commit`, `seed`).
 *
 * A fork room `fork:<draft>:<doc>` is loaded with its document's Live room and kept forwarded:
 * every Live batch is sent to Live's subscribers first and then imported into each loaded fork of
 * that document, and a fork loaded cold imports Live first. So a caller never forwards; whatever it
 * reads from a fork is already up to Live. (Design §4 lists `forward` and `load` as methods; both
 * are inside `read`, `write` and `commit` here.)
 *
 * `Tx` is the host's transaction; the adapter writes snapshot rows in it and imports a commit's
 * batch into the room only once it has committed.
 */
export interface DocumentRooms<Tx> {
  read(room: DocumentRoom, options?: { peer?: PeerId }): Promise<RoomDocs>;

  sync(room: DocumentRoom, version: Uint8Array): Promise<RoomSync>;

  write(room: DocumentRoom, batch: Uint8Array, origin: RoomOrigin): Promise<{ pending: boolean }>;

  /**
   * A command's batch (an AI write, a press, `./mf doc`): the snapshots of the docs it changes are
   * written in `tx`, and the batch is imported into the room after `tx` commits, as `write` does.
   * Every doc a command touches is in its snapshot rows before it acknowledges, so its write
   * survives a crash right after.
   *
   * Every save merges first: it imports the stored row of each doc it writes, if newer, before
   * exporting the snapshot (design §4). A debounced save already running when a command commits
   * would otherwise overwrite the command's row with an older snapshot; a deploy overlap is the
   * other case. So this is every save's rule, not only a deploy's.
   */
  commit(tx: Tx, room: DocumentRoom, batch: Uint8Array, origin: RoomOrigin): Promise<void>;

  seed(tx: Tx, room: DocumentRoom, snapshots: Uint8Array): Promise<void>;

  subscribe(room: DocumentRoom, listener: (batch: RoomBatch) => void): () => void;

  flush(room: DocumentRoom): Promise<void>;

  loaded(): string[];

  unload(room: DocumentRoom): Promise<void>;
}
