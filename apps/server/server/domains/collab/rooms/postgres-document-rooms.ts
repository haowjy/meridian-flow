import type { DocumentId } from "@meridian/contracts";
import { type DocumentRoom, liveRoomOf, loroRoomName } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import {
  documentForks,
  documentSnapshots,
  documents,
  type StoredFrontiers,
} from "@meridian/database/schema";
import {
  type DocKey,
  decodeEnvelope,
  decodeRoomVersion,
  encodeChanges,
  encodeEnvelope,
  encodeRoomVersion,
  freshServerPeerId,
  type Imported,
  RoomDocs,
  type ShapeSchema,
} from "@meridian/document-model";
import type { DocumentRooms, RoomBatch, RoomOrigin } from "@meridian/document-model/rooms";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { LoroDoc, PeerID } from "loro-crdt";
import { processDetachedWork } from "../../../shared/detached-work.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  holdsFrontiers,
  loroFrontiers,
  storedFrontiers,
  writeSnapshots,
} from "../../../shared/document-snapshots.js";
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
  /** A Live room whose rows pass this many bytes compacts its history on unload... */
  compactBytes: number;
  /** ...cutting each doc where it stood at least this long ago (design §4, "History cutoff"). */
  historyMs: number;
}

export const DEFAULT_ROOM_BOUNDS: RoomBounds = {
  debounceMs: 2_000,
  maxDebounceMs: 10_000,
  idleMs: 5 * 60_000,
  maxRooms: 200,
  maxBytes: 1024 * 1024 * 1024,
  compactBytes: 5 * 1024 * 1024,
  historyMs: 7 * 24 * 60 * 60_000,
};

/** A loaded room's estimated memory against its snapshot bytes, as gate 3 measured it. */
const LOADED_SIZE_FACTOR = 10;

export interface PostgresDocumentRooms extends DocumentRooms<DrizzleDb> {
  /** Room names loaded now. */
  loaded(): string[];
  /** Save every loaded room and free it: the process is stopping. */
  close(): Promise<void>;
  /**
   * Ends the documents' loaded rooms, Live and forks, without saving: timers stop, unsaved
   * batches are dropped and the docs are freed. A purge calls it after its transaction commits
   * (a rollback leaves the rooms as they were); until then a save writes nothing for a purged
   * document (`writeRows`). It also deletes the Live rows of documents that never got a
   * `documents` row (an import that stopped wrote their first states ahead of their creates); a
   * document with a row keeps its rows here: its row's delete, or the purge, takes them.
   */
  end(documentIds: readonly DocumentId[]): Promise<void>;
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
  /** Ends the room's pending save in `processDetachedWork`, which shutdown and DB tests drain. */
  settleSave: (() => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
  snapshotBytes: number;
  /** Saves and the unload run one at a time, in this order. */
  queue: Promise<void>;
  /** Saves queued or running; the tracked save settles only when none is left. */
  saving: number;
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
  /** The packed collab schema this server writes: a save raises `documents.schema_version` to it. */
  schemaVersion: number;
  /** A save of a Live room's rows committed: its text moved for everyone who derives from it. */
  onLiveSaved?(documentId: DocumentId): void;
  bounds?: Partial<RoomBounds>;
}): PostgresDocumentRooms {
  const { db, shape, eventSink, schemaVersion } = input;
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
      // A failed unload leaves the room loaded; whoever asked for the unload hears the failure.
      if (existing?.unloading) await Promise.allSettled([existing.unloading]);
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
        dirty: new Set(docs.forward().changed),
        firstDirtyAt: 0,
        saveTimer: null,
        settleSave: null,
        idleTimer: null,
        lastUsed: Date.now(),
        snapshotBytes: rows.reduce((sum, row) => sum + row.snapshot.byteLength, 0),
        queue: Promise.resolve(),
        saving: 0,
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

  /**
   * What a loaded room does with every import: save, tell subscribers, forward forks. A restore
   * the room's copy wrote on the import (design §1, "Removed blocks", rule 1) follows the batch as
   * the room's own. A fork forwarded hears nothing of Live's batch, only its own restore.
   */
  function imported(
    loaded: Loaded,
    { changed, restore }: Imported,
    batch: Uint8Array | null,
    origin: RoomOrigin,
  ) {
    if (changed.length === 0) return;
    markDirty(loaded, changed);
    if (batch) emitTo(loaded.room, batch, origin);
    if (restore) emitTo(loaded.room, encodeChanges([restore]), "server:restore");
    if (loaded.room.kind === "live")
      for (const fork of forksOf(loaded.room.documentId))
        imported(fork, fork.docs.forward(), null, origin);
  }

  function importInto(loaded: Loaded, batch: Uint8Array, origin: RoomOrigin) {
    const result = loaded.docs.importBatch(decodeEnvelope(batch));
    imported(loaded, result, batch, origin);
    return result;
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
    if (!loaded.settleSave)
      void processDetachedWork.track(
        new Promise<void>((resolve) => {
          loaded.settleSave = resolve;
        }),
        `document room save ${loaded.name}`,
      );
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
      .filter((row) => !holdsFrontiers(docs.doc(row.docKey), row.frontiers))
      .map((row) => row.docKey);
    if (lacking.length === 0) return null;
    const rows = await readRows(tx, name, lacking);
    const before = docs.version();
    const { changed } = docs.importBatch(new Map(rows.map((row) => [row.docKey, row.snapshot])));
    if (changed.length === 0) return null;
    // The delta holds the copy's own restore too, if the import wrote one.
    return { changed, delta: encodeEnvelope(docs.exportSince(before)) };
  }

  async function writeRows(
    tx: DrizzleDb,
    room: DocumentRoom,
    docs: RoomDocs,
    keys: Iterable<DocKey>,
  ) {
    // A purged document holds no content: every write to its rows runs under its lock, which the
    // purge held, so this read decides whether the write comes before or after the purge.
    const [row] = await tx
      .select({ purgedAt: documents.contentPurgedAt })
      .from(documents)
      .where(eq(documents.id, room.documentId));
    if (row?.purgedAt) return { bytes: 0, docs: 0 };
    const rows = [...keys].flatMap((docKey) => {
      const doc = docs.doc(docKey);
      return doc ? [{ roomKey: loroRoomName(room), docKey, doc }] : [];
    });
    if (rows.length === 0) return { bytes: 0, docs: 0 };
    const bytes = await writeSnapshots(tx, rows);
    await tx
      .update(documents)
      .set({
        schemaVersion: sql`greatest(${documents.schemaVersion}, ${schemaVersion})`,
        // Live's saves move the document's content: its derivations are stale from here.
        ...(room.kind === "live" ? { contentSeq: sql`${documents.contentSeq} + 1` } : {}),
      })
      .where(eq(documents.id, room.documentId));
    if (room.kind === "live") deferUntilDrizzleCommit(() => input.onLiveSaved?.(room.documentId));
    return { bytes, docs: rows.length };
  }

  /** One save of a loaded room's unsaved docs, queued behind the room's other saves. */
  function save(loaded: Loaded, reason: string): Promise<void> {
    loaded.saving++;
    const run = loaded.queue.then(() => saveUnlessIdle(loaded, reason));
    // The next save waits for this one to settle; this one's caller hears its failure.
    loaded.queue = Promise.allSettled([run]).then(() => {
      loaded.saving--;
      settleIfIdle(loaded);
    });
    return run;
  }

  /** Whatever ended a save or dropped the room's dirty docs: nothing is waiting any more. */
  function settleIfIdle(loaded: Loaded) {
    if (loaded.saving > 0 || loaded.saveTimer || (loaded.dirty.size > 0 && !loaded.docs.isFreed))
      return;
    loaded.settleSave?.();
    loaded.settleSave = null;
  }

  async function saveUnlessIdle(loaded: Loaded, reason: string) {
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
          // The room ended while this save waited for the lock.
          if (loaded.docs.isFreed) return;
          const merge = await mergeStored(tx, loaded.name, loaded.docs);
          if (merge) {
            merged = true;
            // What the merge brings reaches the room's sockets and forks like any batch: a tab
            // rejoining resends only what the room lacks, so nobody else would ever get it.
            const result = { changed: merge.changed, pending: false, restore: null };
            imported(loaded, result, merge.delta, "server:merge");
          }
          // Taken here, after the merge and right before the export, so a batch landing during
          // the awaits above is in this save and one landing after it stays dirty for the next.
          keys = loaded.dirty;
          loaded.dirty = new Set();
          loaded.firstDirtyAt = 0;
          if (loaded.saveTimer) clearTimeout(loaded.saveTimer);
          loaded.saveTimer = null;
          written = await writeRows(tx, loaded.room, loaded.docs, keys);
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
      if (room.kind === "live" && loaded.snapshotBytes > bounds.compactBytes)
        await compact(room).catch((cause) =>
          emitEvent(eventSink, {
            level: "error",
            source: "collab.rooms",
            name: "history.compact_failed",
            correlation: { documentId: room.documentId },
            payload: { room: loaded.name, error: String(cause) },
          }),
        );
    })();
    loaded.unloading = run;
    // A failed save keeps the room loaded and dirty; the next unload or save tries again.
    run.catch(() => {
      if (!loaded.docs.isFreed) loaded.unloading = null;
    });
    return run;
  }

  /**
   * Cuts the history of a Live room's docs, and of its forks, where each doc stood at its history
   * mark, once that mark is `historyMs` old and the room's rows pass `compactBytes` (design §4).
   * It works on the stored rows under the document's lock, after the room unloaded. Each fork is
   * first forwarded to Live and cut at Live's marks: a fork cut there keeps importing Live, and
   * one left behind the cut never could. Content does not change, so `content_seq` does not move.
   * A tab whose base is below a cut is refused from then on (`HistoryCutoffError`).
   */
  async function compact(live: DocumentRoom & { kind: "live" }) {
    const name = loroRoomName(live);
    const result = await runOutsideDrizzleTransaction(() =>
      runInDrizzleTransaction(db, async () => {
        const tx = currentDrizzleDb(db);
        await lockRoom(tx, live);
        const [size] = await tx
          .select({
            bytes: sql<number>`coalesce(sum(octet_length(${documentSnapshots.snapshot})), 0)::bigint`,
          })
          .from(documentSnapshots)
          .where(eq(documentSnapshots.roomKey, name));
        const before = Number(size?.bytes ?? 0);
        if (before <= bounds.compactBytes) return null;
        const ripe = await tx
          .select({ docKey: documentSnapshots.docKey, mark: documentSnapshots.historyMark })
          .from(documentSnapshots)
          .where(
            and(
              eq(documentSnapshots.roomKey, name),
              lte(documentSnapshots.historyMarkAt, new Date(Date.now() - bounds.historyMs)),
            ),
          );
        if (ripe.length === 0) return null;
        const marks = new Map(ripe.map((row) => [row.docKey, row.mark]));
        const liveDocs = await build(tx, live, null, freshServerPeerId());
        let after = before;
        let cut = 0;
        let forksCut = 0;
        try {
          const forks = await tx
            .select({ draftId: documentForks.draftId })
            .from(documentForks)
            .where(eq(documentForks.documentId, live.documentId));
          for (const { draftId } of forks) {
            const fork = { kind: "fork", draftId, documentId: live.documentId } as const;
            const forkName = loroRoomName(fork);
            const stored = await readFrontiers(tx, forkName);
            if (stored.length === 0) continue;
            const docs = await build(tx, fork, liveDocs, freshServerPeerId());
            try {
              for (const { docKey } of stored) {
                const saved = await cutRow(
                  tx,
                  forkName,
                  docKey,
                  docs.doc(docKey),
                  marks.get(docKey),
                );
                if (saved > 0) forksCut++;
              }
            } finally {
              docs.free();
            }
          }
          for (const [docKey, mark] of marks) {
            const saved = await cutRow(tx, name, docKey, liveDocs.doc(docKey), mark);
            after -= saved;
            if (saved > 0) cut++;
          }
        } finally {
          liveDocs.free();
        }
        return { before, after, docs: cut, forkDocs: forksCut };
      }),
    );
    if (!result || result.docs + result.forkDocs === 0) return;
    emitEvent(eventSink, {
      level: "info",
      source: "collab.rooms",
      name: "history.compacted",
      correlation: { documentId: live.documentId },
      payload: {
        bytesBefore: result.before,
        bytesAfter: result.after,
        docs: result.docs,
        forkDocs: result.forkDocs,
      },
    });
  }

  /**
   * Rewrites one row as `doc` cut at `mark`, and moves the mark to where the doc stands now, so
   * the next compaction cuts there. Returns the bytes the row lost: 0 for no cut (no mark, or one
   * the doc lacks), and 0 where the cut would not shrink the row (a doc little changed since its
   * mark), which keeps its history and only moves the mark.
   */
  async function cutRow(
    tx: DrizzleDb,
    roomKey: string,
    docKey: DocKey,
    doc: LoroDoc | undefined,
    mark: StoredFrontiers | undefined,
  ): Promise<number> {
    if (!doc || !mark || mark.length === 0 || !holdsFrontiers(doc, mark)) return 0;
    const shallow = doc.export({ mode: "shallow-snapshot", frontiers: loroFrontiers(mark) });
    const [row] = await tx
      .select({ bytes: sql<number>`octet_length(${documentSnapshots.snapshot})` })
      .from(documentSnapshots)
      .where(and(eq(documentSnapshots.roomKey, roomKey), eq(documentSnapshots.docKey, docKey)));
    const stored = Number(row?.bytes ?? 0);
    const now = storedFrontiers(doc);
    const shrinks = shallow.byteLength < stored;
    await tx
      .update(documentSnapshots)
      .set({
        ...(shrinks
          ? {
              snapshot: Buffer.from(shallow.buffer, shallow.byteOffset, shallow.byteLength),
              frontiers: now,
            }
          : {}),
        historyMark: now,
        historyMarkAt: sql`now()`,
      })
      .where(and(eq(documentSnapshots.roomKey, roomKey), eq(documentSnapshots.docKey, docKey)));
    return shrinks ? stored - shallow.byteLength : 0;
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
      const { pending } = importInto(await load(room), batch, origin);
      return { pending };
    },

    commit: (given, room, batch, origin) =>
      inTransaction(given, async (tx) => {
        const entries = decodeEnvelope(batch);
        await lockRoom(tx, room);
        const copy = await copyInTransaction(tx, room, freshServerPeerId());
        let restore: Uint8Array | null = null;
        try {
          const result = copy.importBatch(entries);
          if (result.restore) restore = encodeChanges([result.restore]);
          await writeRows(tx, room, copy, result.changed);
        } finally {
          copy.free();
        }
        const land = () => {
          const loaded = rooms.get(loroRoomName(room));
          // A loaded room answers the batch on its own copy, as `importBatch` does everywhere.
          if (loaded && !loaded.unloading) return void importInto(loaded, batch, origin);
          emitTo(room, batch, origin);
          if (restore) emitTo(room, restore, "server:restore");
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
          await writeRows(tx, room, docs, entries.keys());
        } finally {
          docs.free();
        }
        const land = () => {
          const loaded = rooms.get(name);
          if (!loaded || loaded.unloading) return emitTo(room, snapshots, "server:seed");
          importInto(loaded, snapshots, "server:seed");
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

    // The save takes the document's lock in a transaction of its own: a caller whose transaction
    // holds that lock and awaits this waits on itself.
    async flush(room) {
      const loaded = rooms.get(loroRoomName(room));
      if (loaded && !loaded.docs.isFreed) await save(loaded, "flush");
    },

    unload: unloadRoom,

    loaded: () => [...rooms.keys()],

    async end(documentIds) {
      if (documentIds.length === 0) return;
      // A load in flight would register its room after this one ended.
      await Promise.allSettled([...loading.values()]);
      const ending = new Set<string>(documentIds);
      const victims = [...rooms.values()]
        .filter((r) => ending.has(r.room.documentId))
        .sort((a, b) => Number(b.room.kind === "fork") - Number(a.room.kind === "fork"));
      for (const loaded of victims) {
        if (loaded.idleTimer) clearTimeout(loaded.idleTimer);
        if (loaded.saveTimer) clearTimeout(loaded.saveTimer);
        loaded.idleTimer = loaded.saveTimer = null;
        loaded.dirty = new Set();
        loaded.firstDirtyAt = 0;
        if (rooms.get(loaded.name) === loaded) rooms.delete(loaded.name);
        // A save already running finishes with the docs it started on.
        await loaded.queue;
        loaded.docs.free();
        settleIfIdle(loaded);
      }
      await currentDrizzleDb(db).execute(sql`
        delete from document_snapshots s
        where s.room_key in (${sql.join(
          documentIds.map((id) => sql`${`live:${id}`}`),
          sql`, `,
        )})
          and not exists (select 1 from documents d where 'live:' || d.id::text = s.room_key)`);
    },

    async close() {
      closed = true;
      await Promise.allSettled([...loading.values()]);
      const live = [...rooms.values()].filter((r) => r.room.kind === "live");
      await Promise.all(live.map((r) => unloadRoom(r.room)));
      await Promise.all([...rooms.values()].map((r) => unloadRoom(r.room)));
    },
  };
}
