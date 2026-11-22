import type { DocumentRoom } from "@meridian/contracts/protocol";
import type { PeerId } from "../peer.js";
import type { RoomDocs } from "../room-docs.js";

/**
 * Who sent a batch into a room: a socket's connection id, or `server:<what>` for the server's own
 * writers. A subscriber skips the batches it sent itself. It is never an author: authors are
 * commit messages inside the bytes (design §5).
 */
export type RoomOrigin = string;

/** A batch a room imported, as its subscribers receive it. */
export interface RoomBatch {
  room: DocumentRoom;
  /** The envelope as it arrived: forward it unchanged. */
  batch: Uint8Array;
  origin: RoomOrigin;
}

/** The room's current version and what a joining copy lacks, both envelopes. */
export interface RoomSync {
  version: Uint8Array;
  /** Null when the copy lacks nothing. */
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
  /**
   * A private copy of the room's docs, forked under `peer` (default: a fresh server peer), loading
   * the room if it is not loaded. A fork room's copy carries its own copy of Live's docs
   * (`docs.live`). The caller owns the copy and calls `free()` on it; nothing it does reaches the
   * room except through `commit` or `write`.
   */
  read(room: DocumentRoom, options?: { peer?: PeerId }): Promise<RoomDocs>;

  /** For a Join: the room's version and the update a copy at `version` lacks. */
  sync(room: DocumentRoom, version: Uint8Array): Promise<RoomSync>;

  /**
   * A client's batch (a keystroke): imported, sent to the other subscribers, forwarded into loaded
   * forks, and saved on the debounce (2 s after the last batch, 10 s after the first). Resolves
   * once imported, which is when the socket acks it; `pending` says some ops wait on others not yet
   * seen, and the batch is acked either way. Rejects for two things only, and then imports none of
   * the batch: bytes that do not decode or fail Loro's checksum (`EnvelopeError`,
   * `CorruptDocBytesError`: `LORO_ROOM_ERROR.CORRUPT_UPDATE`), and an update that depends on
   * history below a doc's shallow cutoff (`HistoryCutoffError`: `LORO_ROOM_ERROR.HISTORY_CUTOFF`).
   */
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

  /**
   * A first state, as snapshots by doc key (an envelope): a new document, an import. Written in
   * `tx`; a loaded room imports it after commit.
   */
  seed(tx: Tx, room: DocumentRoom, snapshots: Uint8Array): Promise<void>;

  /** Every batch the room imports from now on, from any origin, in import order. */
  subscribe(room: DocumentRoom, listener: (batch: RoomBatch) => void): () => void;

  /** Save the room's unsaved docs now (an AI turn's end, a press). */
  flush(room: DocumentRoom): Promise<void>;

  /**
   * Save and drop the room: every doc it holds is freed. Unloading a Live room unloads its loaded
   * forks first. The adapter also unloads idle rooms, and the least recently used above its bound.
   */
  unload(room: DocumentRoom): Promise<void>;
}
