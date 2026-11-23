import { type DocumentRoom, liveRoomOf, loroRoomName } from "@meridian/contracts/protocol";
import type { Frontiers } from "loro-crdt";
import { decodeEnvelope, encodeEnvelope } from "../envelope.js";
import { freshServerPeerId } from "../peer.js";
import { type Imported, RoomDocs } from "../room-docs.js";
import type { DocKey, ShapeSchema } from "../shape.js";
import { decodeRoomVersion, encodeRoomVersion } from "../version.js";
import { encodeChanges } from "../write.js";
import type { DocumentRooms, RoomBatch, RoomOrigin } from "./document-rooms.js";

/** A `document_snapshots` row as the in-memory adapter keeps it. */
export interface SnapshotRow {
  snapshot: Uint8Array;
  frontiers: Frontiers;
  savedAt: number;
}

/** The in-memory adapter's transaction: rows and after-commit imports, applied by `transaction`. */
export interface MemoryRoomTx {
  readonly rows: Map<string, Map<DocKey, SnapshotRow>>;
  readonly afterCommit: (() => void)[];
}

export interface MemoryDocumentRooms extends DocumentRooms<MemoryRoomTx> {
  /** Run `work` in a transaction: its rows land and its imports run only if it resolves. */
  transaction<T>(work: (tx: MemoryRoomTx) => Promise<T>): Promise<T>;
  /** The stored rows by room name, as a reload would read them. */
  rows(): ReadonlyMap<string, ReadonlyMap<DocKey, SnapshotRow>>;
  /** Room names loaded now. */
  loaded(): string[];
  /** Unload every room, freeing every doc. */
  close(): Promise<void>;
}

interface Loaded {
  room: DocumentRoom;
  docs: RoomDocs;
  dirty: Set<DocKey>;
}

/**
 * The in-process adapter of `DocumentRooms` with its rows in memory: for tests, and for 1b, 1c and
 * 1d to build against before the Postgres adapter exists. It keeps the contract's orderings
 * (Live's subscribers before forks, a commit's import after its transaction) but saves only on
 * `flush` and `unload`: there is no debounce timer and no bound on loaded rooms.
 */
export function createMemoryDocumentRooms(shape: ShapeSchema): MemoryDocumentRooms {
  const stored = new Map<string, Map<DocKey, SnapshotRow>>();
  const loadedRooms = new Map<string, Loaded>();
  const listeners = new Map<string, Set<(batch: RoomBatch) => void>>();

  const load = (room: DocumentRoom): Loaded => {
    const name = loroRoomName(room);
    const existing = loadedRooms.get(name);
    if (existing) return existing;
    const live = room.kind === "fork" ? load(liveRoomOf(room)).docs : null;
    const rows = new Map([...(stored.get(name) ?? [])].map(([key, row]) => [key, row.snapshot]));
    const docs = RoomDocs.load(shape, freshServerPeerId(), rows, live);
    const loaded = { room, docs, dirty: new Set(docs.forward().changed) };
    loadedRooms.set(name, loaded);
    return loaded;
  };

  const forks = (documentId: string) =>
    [...loadedRooms.values()].filter(
      (l) => l.room.kind === "fork" && l.room.documentId === documentId,
    );

  const relay = (loaded: Loaded, batch: Uint8Array, origin: RoomOrigin) => {
    for (const listener of listeners.get(loroRoomName(loaded.room)) ?? [])
      listener({ room: loaded.room, batch, origin });
  };

  // As the Postgres adapter: what an import changed is saved and sent, and a restore the room's
  // copy wrote on it (design §1, rule 1) goes out after the batch as the room's own.
  const landed = (loaded: Loaded, { changed, restore }: Imported) => {
    for (const key of changed) loaded.dirty.add(key);
    if (restore.length) relay(loaded, encodeChanges(restore), "server:restore");
  };

  const importInto = (loaded: Loaded, batch: Uint8Array, origin: RoomOrigin) => {
    const imported = loaded.docs.importBatch(decodeEnvelope(batch));
    relay(loaded, batch, origin);
    landed(loaded, imported);
    if (loaded.room.kind === "live")
      for (const fork of forks(loaded.room.documentId)) landed(fork, fork.docs.forward());
    return { pending: imported.pending };
  };

  const save = (loaded: Loaded, keys: Iterable<DocKey>, into = stored) => {
    const name = loroRoomName(loaded.room);
    let rows = into.get(name);
    if (!rows) {
      rows = new Map();
      into.set(name, rows);
    }
    for (const [key, snapshot] of loaded.docs.snapshots(keys)) {
      const frontiers = loaded.docs.doc(key)?.frontiers() ?? [];
      rows.set(key, { snapshot, frontiers, savedAt: Date.now() });
    }
  };

  const flush = (loaded: Loaded) => {
    save(loaded, loaded.dirty);
    loaded.dirty.clear();
  };

  const unload = (room: DocumentRoom) => {
    const name = loroRoomName(room);
    const loaded = loadedRooms.get(name);
    if (!loaded) return;
    if (room.kind === "live") for (const fork of forks(room.documentId)) unload(fork.room);
    flush(loaded);
    loaded.docs.free();
    loadedRooms.delete(name);
  };

  return {
    async read(room, options) {
      return load(room).docs.fork(options?.peer ?? freshServerPeerId());
    },
    async sync(room, version) {
      const { docs } = load(room);
      const update = docs.exportSince(decodeRoomVersion(version));
      return {
        version: encodeRoomVersion(docs.version()),
        update: update.size > 0 ? encodeEnvelope(update) : null,
      };
    },
    async write(room, batch, origin) {
      return importInto(load(room), batch, origin);
    },
    async commit(tx, room, batch, origin) {
      const loaded = load(room);
      const scratch = loaded.docs.fork(freshServerPeerId());
      try {
        const { changed } = scratch.importBatch(decodeEnvelope(batch));
        save({ ...loaded, docs: scratch }, changed, tx.rows);
      } finally {
        scratch.free();
      }
      tx.afterCommit.push(() => {
        const now = loadedRooms.get(loroRoomName(room));
        if (now) importInto(now, batch, origin);
      });
    },
    async seed(tx, room, snapshots) {
      const name = loroRoomName(room);
      let rows = tx.rows.get(name);
      if (!rows) {
        rows = new Map();
        tx.rows.set(name, rows);
      }
      for (const [key, snapshot] of decodeEnvelope(snapshots)) {
        const probe = RoomDocs.load(shape, freshServerPeerId(), new Map([[key, snapshot]]));
        try {
          rows.set(key, {
            snapshot,
            frontiers: probe.doc(key)?.frontiers() ?? [],
            savedAt: Date.now(),
          });
        } finally {
          probe.free();
        }
      }
      tx.afterCommit.push(() => {
        const now = loadedRooms.get(name);
        if (now) importInto(now, snapshots, "server:seed");
      });
    },
    subscribe(room, listener) {
      const name = loroRoomName(room);
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(listener);
      return () => set.delete(listener);
    },
    async flush(room) {
      const loaded = loadedRooms.get(loroRoomName(room));
      if (loaded) flush(loaded);
    },
    async unload(room) {
      unload(room);
    },
    async transaction(work) {
      const tx: MemoryRoomTx = { rows: new Map(), afterCommit: [] };
      const result = await work(tx);
      for (const [name, rows] of tx.rows) {
        let target = stored.get(name);
        if (!target) {
          target = new Map();
          stored.set(name, target);
        }
        for (const [key, row] of rows) target.set(key, row);
      }
      for (const run of tx.afterCommit) run();
      return result;
    },
    rows: () => stored,
    loaded: () => [...loadedRooms.keys()],
    async close() {
      for (const loaded of [...loadedRooms.values()])
        if (loaded.room.kind === "live") unload(loaded.room);
      for (const loaded of [...loadedRooms.values()]) unload(loaded.room);
    },
  };
}
