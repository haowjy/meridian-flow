import { type DocumentRoom, liveRoomOf, loroRoomName } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documentSnapshots, type StoredFrontiers } from "@meridian/database/schema";
import {
  type DocKey,
  decodeEnvelope,
  decodeRoomVersion,
  encodeEnvelope,
  encodeRoomVersion,
  freshServerPeerId,
  RoomDocs,
  type ShapeSchema,
} from "@meridian/document-model";
import type { DocumentRooms, RoomBatch, RoomOrigin } from "@meridian/document-model/rooms";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Frontiers, LoroDoc, PeerID } from "loro-crdt";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  type DrizzleDb,
  deferUntilDrizzleCommit,
  isInDrizzleTransaction,
  runInDrizzleTransaction,
  runOutsideDrizzleTransaction,
} from "../../../shared/drizzle-transaction.js";
import { type EventSink, emitEvent } from "../../observability/index.js";

/** Bounds and timings of the in-process rooms (design §4). */
export interface RoomBounds {
  /** A save runs this long after a room's last batch... */
  debounceMs: number;
  /** ...and at most this long after the first batch it has not saved. */
  maxDebounceMs: number;
  /** A room nobody is subscribed to unloads after this long without use. */
  idleMs: number;
  /** Least recently used rooms unload above this many loaded... */
  maxRooms: number;
  /** ...or above this estimated size: ten times a room's snapshot bytes (gate 3). */
  maxBytes: number;
}

export const DEFAULT_ROOM_BOUNDS: RoomBounds = {
  debounceMs: 2_000,
  maxDebounceMs: 10_000,
  idleMs: 5 * 60_000,
  maxRooms: 200,
  maxBytes: 1024 * 1024 * 1024,
};

/** A loaded room's estimated memory against its snapshot bytes, as gate 3 measured it. */
const LOADED_SIZE_FACTOR = 10;

export interface PostgresDocumentRooms extends DocumentRooms<DrizzleDb> {
  /** Room names loaded now. */
  loaded(): string[];
  /** Save every loaded room and free it: the process is stopping. */
  close(): Promise<void>;
}

interface Loaded {
  readonly room: DocumentRoom;
  readonly name: string;
  readonly docs: RoomDocs;
  /** Docs changed since the last save started. */
  dirty: Set<DocKey>;
  /** When the first unsaved batch arrived; 0 when nothing is unsaved. */
  firstDirtyAt: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
  snapshotBytes: number;
  /** Saves and the unload run one at a time, in this order. */
  queue: Promise<void>;
  /** Set once an unload starts; a load of the same room waits for it. */
  unloading: Promise<void> | null;
}

type Row = { docKey: string; snapshot: Uint8Array; frontiers: StoredFrontiers };

/**
 * `DocumentRooms` on Postgres (design §4): a room's docs live in this process, loaded together from
 * their `document_snapshots` rows, saved (the rows of the docs that changed) on the debounce or on
 * `flush`, forwarded into loaded forks, and freed together on unload.
 *
 * Every save, whoever asks for it, runs under the document's advisory lock and first imports any
 * stored row this process's copy lacks (a debounced save racing a command's commit, or a deploy
 * overlap where two processes save one room), sending what that brings to the room's subscribers
 * and loaded forks like any other batch, so a save never writes a row older than the one it
 * replaces.
 *
 * The cache is filled only outside a transaction: a read or commit inside one, for a room this
 * process has not loaded, builds its copy from the rows the transaction sees, so no loaded room
 * ever holds state a rolled-back transaction wrote. A read inside a transaction also imports the
 * rows the room lacks, which is how a command reads its own seed or commit back.
 */
export function createPostgresDocumentRooms(input: {
  db: Database;
  shape: ShapeSchema;
  eventSink: EventSink;
  bounds?: Partial<RoomBounds>;
}): PostgresDocumentRooms {
  const { db, shape, eventSink } = input;
  const bounds = { ...DEFAULT_ROOM_BOUNDS, ...input.bounds };
  const rooms = new Map<string, Loaded>();
  const loading = new Map<string, Promise<Loaded>>();
  const listeners = new Map<string, Set<(batch: RoomBatch) => void>>();
  let closed = false;

  const lockRoom = (tx: DrizzleDb, room: DocumentRoom) => lockDocumentMutation(tx, room.documentId);

  /**
   * Runs a commit or seed on the caller's ambient transaction, which is what `tx` names when the
   * caller is in one, or on one of its own: its lock and rows must be one transaction's, and its
   * import into the room waits for that transaction's commit.
   */
  const inTransaction = <T>(given: DrizzleDb, work: (tx: DrizzleDb) => Promise<T>) =>
    isInDrizzleTransaction()
      ? work(currentDrizzleDb(given))
      : runInDrizzleTransaction(db, () => work(currentDrizzleDb(db)));

  async function readRows(tx: DrizzleDb, name: string, keys?: readonly DocKey[]): Promise<Row[]> {
    const where = keys
      ? and(eq(documentSnapshots.roomKey, name), inArray(documentSnapshots.docKey, [...keys]))
      : eq(documentSnapshots.roomKey, name);
    return tx
      .select({
        docKey: documentSnapshots.docKey,
        snapshot: documentSnapshots.snapshot,
        frontiers: documentSnapshots.frontiers,
      })
      .from(documentSnapshots)
      .where(where);
  }

  async function readFrontiers(tx: DrizzleDb, name: string) {
    return tx
      .select({ docKey: documentSnapshots.docKey, frontiers: documentSnapshots.frontiers })
      .from(documentSnapshots)
      .where(eq(documentSnapshots.roomKey, name));
  }

  /** Builds a copy of `room` from the rows `tx` sees; a fork room's on a copy of its Live room. */
  async function build(
    tx: DrizzleDb,
    room: DocumentRoom,
    live: RoomDocs | null,
    peer: PeerID,
  ): Promise<RoomDocs> {
    const rows = await readRows(tx, loroRoomName(room));
    const docs = RoomDocs.load(
      shape,
      peer,
      new Map(rows.map((row) => [row.docKey, row.snapshot])),
      live,
    );
    docs.forward();
    return docs;
  }

  function touch(loaded: Loaded) {
    loaded.lastUsed = Date.now();
    if (loaded.idleTimer) clearTimeout(loaded.idleTimer);
    loaded.idleTimer = null;
    if (subscribed(loaded.name)) return;
    loaded.idleTimer = setTimeout(() => {
      loaded.idleTimer = null;
      if (!subscribed(loaded.name)) void unloadRoom(loaded.room).catch(saveFailed(loaded));
    }, bounds.idleMs);
    loaded.idleTimer.unref?.();
  }

  const subscribed = (name: string) => (listeners.get(name)?.size ?? 0) > 0;

  /** The loaded room, loading it (and, for a fork, its Live room first) outside any transaction. */
  async function load(room: DocumentRoom): Promise<Loaded> {
    if (closed) throw new Error("Document rooms are closed");
    const name = loroRoomName(room);
    const existing = rooms.get(name);
    if (existing && !existing.unloading) {
      touch(existing);
      return existing;
    }
    const inFlight = loading.get(name);
    if (inFlight) return inFlight;
    const started = (async () => {
      if (existing?.unloading) await existing.unloading.catch(() => undefined);
      const again = rooms.get(name);
      if (again && !again.unloading) return again;
      const live = room.kind === "fork" ? (await load(liveRoomOf(room))).docs : null;
      const rows = await runOutsideDrizzleTransaction(() => readRows(db, name));
      const docs = RoomDocs.load(
        shape,
        freshServerPeerId(),
        new Map(rows.map((row) => [row.docKey, row.snapshot])),
        live,
      );
      const loaded: Loaded = {
        room,
        name,
        docs,
        dirty: new Set(docs.forward()),
        firstDirtyAt: 0,
        saveTimer: null,
        idleTimer: null,
        lastUsed: Date.now(),
        snapshotBytes: rows.reduce((sum, row) => sum + row.snapshot.byteLength, 0),
        queue: Promise.resolve(),
        unloading: null,
      };
      rooms.set(name, loaded);
      if (loaded.dirty.size > 0) schedule(loaded);
      touch(loaded);
      return loaded;
    })();
    loading.set(name, started);
    try {
      const loaded = await started;
      enforceBounds(loaded);
      return loaded;
    } finally {
      loading.delete(name);
    }
  }

  /** Unloads least recently used rooms above the bounds, unsubscribed ones first. */
  function enforceBounds(keep: Loaded) {
    const size = () =>
      [...rooms.values()].reduce((sum, r) => sum + r.snapshotBytes * LOADED_SIZE_FACTOR, 0);
    const over = () => rooms.size > bounds.maxRooms || size() > bounds.maxBytes;
    if (!over()) return;
    const candidates = [...rooms.values()]
      .filter((r) => r !== keep && !r.unloading && !(r.room.kind === "live" && isLiveOf(keep, r)))
      .sort(
        (a, b) =>
          Number(subscribed(a.name)) - Number(subscribed(b.name)) || a.lastUsed - b.lastUsed,
      );
    let estimate = size();
    let count = rooms.size;
    for (const victim of candidates) {
      if (count <= bounds.maxRooms && estimate <= bounds.maxBytes) break;
      count--;
      estimate -= victim.snapshotBytes * LOADED_SIZE_FACTOR;
      void unloadRoom(victim.room).catch(saveFailed(victim));
    }
  }

  const isLiveOf = (fork: Loaded, live: Loaded) =>
    fork.room.kind === "fork" && fork.room.documentId === live.room.documentId;

  const forksOf = (documentId: string) =>
    [...rooms.values()].filter(
      (r) => r.room.kind === "fork" && r.room.documentId === documentId && !r.unloading,
    );

  /**
   * Sends a batch to the room's subscribers. A room can be unloaded while sockets are still on
   * it (the bound above): a stored batch then reaches them without loading the room.
   */
  function emitTo(room: DocumentRoom, batch: Uint8Array, origin: RoomOrigin) {
    for (const listener of listeners.get(loroRoomName(room)) ?? [])
      listener({ room, batch, origin });
  }

  /** What a loaded room does with every batch it imports: tell subscribers, forward forks, save. */
  function imported(
    loaded: Loaded,
    changed: readonly DocKey[],
    batch: Uint8Array,
    origin: RoomOrigin,
  ) {
    if (changed.length === 0) return;
    markDirty(loaded, changed);
    emitTo(loaded.room, batch, origin);
    if (loaded.room.kind === "live")
      for (const fork of forksOf(loaded.room.documentId)) markDirty(fork, fork.docs.forward());
  }

  function markDirty(loaded: Loaded, keys: Iterable<DocKey>) {
    let any = false;
    for (const key of keys) {
      loaded.dirty.add(key);
      any = true;
    }
    if (any) schedule(loaded);
  }

  function schedule(loaded: Loaded) {
    const now = Date.now();
    if (loaded.firstDirtyAt === 0) loaded.firstDirtyAt = now;
    if (loaded.saveTimer) clearTimeout(loaded.saveTimer);
    const at = Math.min(now + bounds.debounceMs, loaded.firstDirtyAt + bounds.maxDebounceMs);
    loaded.saveTimer = setTimeout(
      () => {
        loaded.saveTimer = null;
        void save(loaded, "debounce").catch(saveFailed(loaded));
      },
      Math.max(0, at - now),
    );
    loaded.saveTimer.unref?.();
  }

  const saveFailed = (loaded: Loaded) => (cause: unknown) =>
    emitEvent(eventSink, {
      level: "error",
      source: "collab.rooms",
      name: "snapshot.save_failed",
      correlation: { documentId: loaded.room.documentId },
      payload: { room: loaded.name, error: String(cause) },
    });

  /**
   * Imports the stored rows `docs` lacks (by their frontiers), as one batch. Returns the keys it
   * changed and the delta it brought, as an envelope, or null.
   */
  async function mergeStored(tx: DrizzleDb, name: string, docs: RoomDocs) {
    const stored = await readFrontiers(tx, name);
    const lacking = stored
      .filter((row) => !knows(docs.doc(row.docKey), row.frontiers))
      .map((row) => row.docKey);
    if (lacking.length === 0) return null;
    const rows = await readRows(tx, name, lacking);
    const before = docs.version();
    const { changed } = docs.importBatch(new Map(rows.map((row) => [row.docKey, row.snapshot])));
    if (changed.length === 0) return null;
    return { changed, delta: encodeEnvelope(docs.exportSince(before)) };
  }

  async function writeRows(tx: DrizzleDb, name: string, docs: RoomDocs, keys: Iterable<DocKey>) {
    const values = [...docs.snapshots(keys)].map(([docKey, snapshot]) => ({
      roomKey: name,
      docKey,
      snapshot: Buffer.from(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength),
      frontiers: storedFrontiers(docs.doc(docKey)?.frontiers() ?? []),
    }));
    if (values.length === 0) return { bytes: 0, docs: 0 };
    await tx
      .insert(documentSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: [documentSnapshots.roomKey, documentSnapshots.docKey],
        set: {
          snapshot: sql`excluded.snapshot`,
          frontiers: sql`excluded.frontiers`,
          savedAt: sql`now()`,
        },
      });
    return {
      bytes: values.reduce((sum, value) => sum + value.snapshot.byteLength, 0),
      docs: values.length,
    };
  }

  /** One save of a loaded room's unsaved docs, queued behind the room's other saves. */
  function save(loaded: Loaded, reason: string): Promise<void> {
    const run = loaded.queue.then(() => saveNow(loaded, reason));
    loaded.queue = run.catch(() => undefined);
    return run;
  }

  async function saveNow(loaded: Loaded, reason: string) {
    if (loaded.docs.isFreed) return;
    if (reason === "debounce" && loaded.dirty.size === 0) return;
    if (loaded.saveTimer) clearTimeout(loaded.saveTimer);
    loaded.saveTimer = null;
    const started = performance.now();
    let keys = new Set<DocKey>();
    let merged = false;
    let written = { bytes: 0, docs: 0 };
    try {
      await runOutsideDrizzleTransaction(() =>
        runInDrizzleTransaction(db, async () => {
          const tx = currentDrizzleDb(db);
          await lockRoom(tx, loaded.room);
          const merge = await mergeStored(tx, loaded.name, loaded.docs);
          if (merge) {
            merged = true;
            // What the merge brings reaches the room's sockets and forks like any batch: a tab
            // rejoining resends only what the room lacks, so nobody else would ever get it.
            imported(loaded, merge.changed, merge.delta, "server:merge");
          }
          // Taken here, after the merge and right before the export, so a batch landing during
          // the awaits above is in this save and one landing after it stays dirty for the next.
          keys = loaded.dirty;
          loaded.dirty = new Set();
          loaded.firstDirtyAt = 0;
          if (loaded.saveTimer) clearTimeout(loaded.saveTimer);
          loaded.saveTimer = null;
          written = await writeRows(tx, loaded.name, loaded.docs, keys);
        }),
      );
    } catch (cause) {
      for (const key of keys) loaded.dirty.add(key);
      if (loaded.dirty.size > 0) schedule(loaded);
      throw cause;
    }
    if (written.docs === 0 && !merged) return;
    loaded.snapshotBytes = Math.max(loaded.snapshotBytes, written.bytes);
    emitEvent(eventSink, {
      level: "info",
      source: "collab.rooms",
      name: "snapshot.saved",
      correlation: { documentId: loaded.room.documentId },
      payload: {
        room: loaded.room.kind,
        reason,
        bytes: written.bytes,
        docs: written.docs,
        merged,
        ms: Math.round(performance.now() - started),
      },
    });
  }

  function unloadRoom(room: DocumentRoom): Promise<void> {
    const loaded = rooms.get(loroRoomName(room));
    if (!loaded) return Promise.resolve();
    if (loaded.unloading) return loaded.unloading;
    const run = (async () => {
      if (room.kind === "live")
        await Promise.all(forksOf(room.documentId).map((fork) => unloadRoom(fork.room)));
      if (loaded.idleTimer) clearTimeout(loaded.idleTimer);
      // A batch can land while a save awaits the database: save until none is left, then free in
      // the same tick, so nothing imported is ever freed unsaved.
      await loaded.queue;
      while (loaded.dirty.size > 0) await save(loaded, "unload");
      if (loaded.saveTimer) clearTimeout(loaded.saveTimer);
      if (rooms.get(loaded.name) === loaded) rooms.delete(loaded.name);
      loaded.docs.free();
    })();
    loaded.unloading = run;
    // A failed save keeps the room loaded and dirty; the next unload or save tries again.
    run.catch(() => {
      if (!loaded.docs.isFreed) loaded.unloading = null;
    });
    return run;
  }

  /**
   * A private copy of `room` for a caller inside a transaction: the loaded room's state plus the
   * rows the transaction sees that it lacks, or, unloaded, the rows alone.
   */
  async function copyInTransaction(
    tx: DrizzleDb,
    room: DocumentRoom,
    peer: PeerID,
  ): Promise<RoomDocs> {
    const loaded = rooms.get(loroRoomName(room));
    if (loaded && !loaded.unloading) {
      touch(loaded);
      const copy = loaded.docs.fork(peer);
      try {
        await mergeIntoCopy(tx, room, copy);
      } catch (cause) {
        copy.free();
        throw cause;
      }
      return copy;
    }
    if (room.kind === "live") return build(tx, room, null, peer);
    const live = await copyInTransaction(tx, liveRoomOf(room), peer);
    try {
      const docs = await build(tx, room, live, peer);
      // A copy owns the Live copy it reads through; `fork` makes one that does.
      const copy = docs.fork(peer);
      docs.free();
      return copy;
    } finally {
      live.free();
    }
  }

  async function mergeIntoCopy(tx: DrizzleDb, room: DocumentRoom, copy: RoomDocs) {
    if (copy.live) {
      await mergeStored(tx, loroRoomName(liveRoomOf(room)), copy.live);
      copy.forward();
    }
    await mergeStored(tx, loroRoomName(room), copy);
  }

  return {
    async read(room, options) {
      const peer = options?.peer ?? freshServerPeerId();
      if (isInDrizzleTransaction()) return copyInTransaction(currentDrizzleDb(db), room, peer);
      return (await load(room)).docs.fork(peer);
    },

    async sync(room, version) {
      const loaded = await load(room);
      const update = loaded.docs.exportSince(decodeRoomVersion(version));
      return {
        version: encodeRoomVersion(loaded.docs.version()),
        update: update.size > 0 ? encodeEnvelope(update) : null,
      };
    },

    async write(room, batch, origin) {
      const loaded = await load(room);
      const { changed, pending } = loaded.docs.importBatch(decodeEnvelope(batch));
      imported(loaded, changed, batch, origin);
      return { pending };
    },

    commit: (given, room, batch, origin) =>
      inTransaction(given, async (tx) => {
        const entries = decodeEnvelope(batch);
        await lockRoom(tx, room);
        const copy = await copyInTransaction(tx, room, freshServerPeerId());
        try {
          const { changed } = copy.importBatch(entries);
          await writeRows(tx, loroRoomName(room), copy, changed);
        } finally {
          copy.free();
        }
        const land = () => {
          const loaded = rooms.get(loroRoomName(room));
          if (!loaded || loaded.unloading) return emitTo(room, batch, origin);
          imported(loaded, loaded.docs.importBatch(decodeEnvelope(batch)).changed, batch, origin);
        };
        deferUntilDrizzleCommit(land);
      }),

    seed: (given, room, snapshots) =>
      inTransaction(given, async (tx) => {
        const entries = decodeEnvelope(snapshots);
        const name = loroRoomName(room);
        await lockRoom(tx, room);
        const docs = RoomDocs.load(shape, freshServerPeerId(), entries);
        try {
          await writeRows(tx, name, docs, entries.keys());
        } finally {
          docs.free();
        }
        const land = () => {
          const loaded = rooms.get(name);
          if (!loaded || loaded.unloading) return emitTo(room, snapshots, "server:seed");
          imported(loaded, loaded.docs.importBatch(entries).changed, snapshots, "server:seed");
        };
        deferUntilDrizzleCommit(land);
      }),

    subscribe(room, listener) {
      const name = loroRoomName(room);
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(name);
        const loaded = rooms.get(name);
        if (loaded) touch(loaded);
      };
    },

    async flush(room) {
      const loaded = rooms.get(loroRoomName(room));
      if (loaded && !loaded.docs.isFreed) await save(loaded, "flush");
    },

    unload: unloadRoom,

    loaded: () => [...rooms.keys()],

    async close() {
      closed = true;
      await Promise.all([...loading.values()].map((p) => p.catch(() => undefined)));
      const live = [...rooms.values()].filter((r) => r.room.kind === "live");
      await Promise.all(live.map((r) => unloadRoom(r.room)));
      await Promise.all([...rooms.values()].map((r) => unloadRoom(r.room)));
    },
  };
}

/**
 * Whether `doc` has every op `frontiers` names. `frontiersToVV` throws for an id the doc lacks
 * (loro-crdt 1.18, though its changelog says it returns undefined).
 */
function knows(doc: LoroDoc | undefined, frontiers: StoredFrontiers): boolean {
  if (!doc) return false;
  try {
    return (
      doc.frontiersToVV(
        frontiers.map(({ peer, counter }) => ({ peer: peer as PeerID, counter })),
      ) !== undefined
    );
  } catch {
    return false;
  }
}

function storedFrontiers(frontiers: Frontiers): StoredFrontiers {
  return frontiers.map(({ peer, counter }) => ({ peer, counter }));
}
