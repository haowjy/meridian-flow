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
