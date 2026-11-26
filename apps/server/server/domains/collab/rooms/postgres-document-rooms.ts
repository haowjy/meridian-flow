import type { DocumentId, DraftId } from "@meridian/contracts";
import { type DocumentRoom, liveRoomOf, loroRoomName } from "@meridian/contracts/protocol";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { Database } from "@meridian/database";
import {
  documentForks,
  documentSnapshots,
  documents,
  drafts,
  type StoredFrontiers,
} from "@meridian/database/schema";
import {
  changedBlocks,
  type DocKey,
  decodeEnvelope,
  decodeRoomVersion,
  docCovers,
  docVersion,
  encodeChanges,
  encodeEnvelope,
  encodeRoomVersion,
  freshServerPeerId,
  type Imported,
  isServerPeer,
  type PeerId,
  pendingRemovalVersion,
  RoomDocs,
  type RoomVersion,
  type ShapeSchema,
} from "@meridian/document-model";
import type { DocumentRooms, RoomBatch, RoomOrigin } from "@meridian/document-model/rooms";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { LoroDoc, PeerID } from "loro-crdt";
import { processDetachedWork } from "../../../shared/detached-work.js";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import {
  holdsFrontiers,
  loroFrontiers,
  sameFrontiers,
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

export interface RoomBounds {
  debounceMs: number;
  maxDebounceMs: number;
  idleMs: number;
  maxRooms: number;
  maxBytes: number;
  compactBytes: number;
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

const LOADED_SIZE_FACTOR = 10;

const FORK_RETIRE_BATCH = 200;

export interface PostgresDocumentRooms extends DocumentRooms<DrizzleDb> {
  close(): Promise<void>;
  end(documentIds: readonly DocumentId[]): Promise<void>;
  endRooms(rooms: readonly DocumentRoom[]): Promise<void>;
  retireEmptyForks(now?: Date): Promise<number>;
}

interface Loaded {
  readonly room: DocumentRoom;
  readonly name: string;
  readonly docs: RoomDocs;
  dirty: Set<DocKey>;
  firstDirtyAt: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
  settleSave: (() => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastUsed: number;
  snapshotBytes: number;
  queue: Promise<void>;
  saving: number;
  unloading: Promise<void> | null;
}

type Row = { docKey: string; snapshot: Uint8Array; frontiers: StoredFrontiers };
type Written = { bytes: number; docs: number; stored: RoomVersion };
const NOTHING_WRITTEN: Written = { bytes: 0, docs: 0, stored: new Map() };
type ForkRoom = Extract<DocumentRoom, { kind: "fork" }>;

export async function markFork(tx: DrizzleDb, room: ForkRoom, docs: RoomDocs): Promise<boolean> {
  const changes = changedBlocks(docs);
  const pending = changes.length > 0;
  const [before] = await tx
    .select({ pending: documentForks.pending })
    .from(documentForks)
    .where(
      and(eq(documentForks.draftId, room.draftId), eq(documentForks.documentId, room.documentId)),
    );
  const removals = pending ? pendingRemovalVersion(docs, changes) : new Map();
  const state = {
    pending,
    liveVersion: removals.size > 0 ? Buffer.from(encodeRoomVersion(removals)) : null,
    writerWrote: pending && writerWrote(docs, changes),
    changeCount: changes.length,
  };
  await tx
    .insert(documentForks)
    .values({
      draftId: room.draftId,
      documentId: room.documentId,
      ...state,
      emptySince: pending ? null : new Date(),
    })
    .onConflictDoUpdate({
      target: [documentForks.draftId, documentForks.documentId],
      set: {
        ...state,
        checkedAt: sql`now()`,
        emptySince: pending ? null : sql`coalesce(${documentForks.emptySince}, now())`,
      },
    });
  return (before?.pending ?? false) !== pending;
}

function writerWrote(docs: RoomDocs, changes: readonly { blocks: readonly string[] }[]): boolean {
  const live = docs.live;
  const ahead = (doc: LoroDoc | undefined, base: LoroDoc | undefined) => {
    if (!doc) return false;
    const held = base ? docVersion(base) : new Map<string, number>();
    for (const [peer, counter] of docVersion(doc))
      if (!isServerPeer(peer as PeerId) && counter > (held.get(peer) ?? 0)) return true;
    return false;
  };
  if (ahead(docs.structure, live?.structure)) return true;
  return changes.some((change) =>
    change.blocks.some((id) => ahead(docs.textOf(id), live?.textOf(id))),
  );
}

export function createPostgresDocumentRooms(input: {
  db: Database;
  shape: ShapeSchema;
  eventSink: EventSink;
  schemaVersion: number;
  onLiveSaved?(documentId: DocumentId): void;
  onForkPendingChanged?(draftId: DraftId): Promise<void>;
  onForkDeleted?(room: ForkRoom): Promise<void>;
  bounds?: Partial<RoomBounds>;
}): PostgresDocumentRooms {
  const { db, shape, eventSink, schemaVersion } = input;
  const bounds = { ...DEFAULT_ROOM_BOUNDS, ...input.bounds };
  const rooms = new Map<string, Loaded>();
  const loading = new Map<string, Promise<Loaded>>();
  const listeners = new Map<string, Set<(batch: RoomBatch) => void>>();
  let closed = false;

  const lockRoom = (tx: DrizzleDb, room: DocumentRoom) => lockDocumentMutation(tx, room.documentId);

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

  function emitTo(room: DocumentRoom, batch: Uint8Array, origin: RoomOrigin) {
    for (const listener of listeners.get(loroRoomName(room)) ?? [])
      listener({ room, batch, origin });
  }

  function imported(
    loaded: Loaded,
    { changed, pending, restore }: Imported,
    batch: Uint8Array | null,
    origin: RoomOrigin,
    stored?: RoomVersion,
  ) {
    markDirty(loaded, changed);
    if (stored) {
      for (const key of loaded.dirty) {
        const version = stored.get(key);
        const doc = version && loaded.docs.doc(key);
        if (doc && docCovers(version, docVersion(doc))) loaded.dirty.delete(key);
      }
      if (loaded.dirty.size === 0) cancelSave(loaded);
    }
    if (changed.length === 0) {
      if (pending && batch) emitTo(loaded.room, batch, origin);
      return;
    }
    if (batch) emitTo(loaded.room, batch, origin);
    if (restore.length) emitTo(loaded.room, encodeChanges(restore), "server:restore");
    if (loaded.room.kind === "live")
      for (const fork of forksOf(loaded.room.documentId))
        imported(fork, fork.docs.forward(), null, origin);
  }

  function importInto(loaded: Loaded, batch: Uint8Array, origin: RoomOrigin, stored?: RoomVersion) {
    const result = loaded.docs.importBatch(decodeEnvelope(batch));
    imported(loaded, result, batch, origin, stored);
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

  function cancelSave(loaded: Loaded) {
    if (loaded.saveTimer) clearTimeout(loaded.saveTimer);
    loaded.saveTimer = null;
    loaded.firstDirtyAt = 0;
    settleIfIdle(loaded);
  }

  const saveFailed = (loaded: Loaded) => (cause: unknown) =>
    emitEvent(eventSink, {
      level: "error",
      source: "collab.rooms",
      name: "snapshot.save_failed",
      correlation: { documentId: loaded.room.documentId },
      payload: { room: loaded.name, error: String(cause) },
    });

  async function mergeStored(tx: DrizzleDb, name: string, docs: RoomDocs) {
    const lacking = (await readFrontiers(tx, name))
      .filter((row) => !holdsFrontiers(docs.doc(row.docKey), row.frontiers))
      .map((row) => row.docKey);
    if (lacking.length === 0) return null;
    const rows = await readRows(tx, name, lacking);
    const before = docs.version();
    const { changed } = docs.importBatch(new Map(rows.map((row) => [row.docKey, row.snapshot])));
    if (changed.length === 0) return null;
    const held: RoomVersion = new Map(
      rows.flatMap((row) => {
        const doc = docs.doc(row.docKey);
        return doc && sameFrontiers(storedFrontiers(doc), row.frontiers)
          ? [[row.docKey, docVersion(doc)]]
          : [];
      }),
    );
    return { changed, delta: encodeEnvelope(docs.exportSince(before)), held };
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
    if (row?.purgedAt) return NOTHING_WRITTEN;
    // A purged draft's fork has no rows to write. The purge deletes the draft under this
    // document's lock, so the read needs no row lock: one would follow the document key, against
    // the lock order every press takes.
    if (room.kind === "fork") {
      const [draft] = await tx
        .select({ id: drafts.id })
        .from(drafts)
        .where(eq(drafts.id, room.draftId));
      if (!draft) return NOTHING_WRITTEN;
    }
    const rows = [...keys].flatMap((docKey) => {
      const doc = docs.doc(docKey);
      return doc ? [{ roomKey: loroRoomName(room), docKey, doc }] : [];
    });
    if (rows.length === 0) return NOTHING_WRITTEN;
    const bytes = await writeSnapshots(tx, rows);
    if (room.kind === "fork" && (await markFork(tx, room, docs)))
      await input.onForkPendingChanged?.(room.draftId);
    await tx
      .update(documents)
      .set({
        schemaVersion: sql`greatest(${documents.schemaVersion}, ${schemaVersion})`,
        ...(room.kind === "live" ? { contentSeq: sql`${documents.contentSeq} + 1` } : {}),
      })
      .where(eq(documents.id, room.documentId));
    if (room.kind === "live") deferUntilDrizzleCommit(() => input.onLiveSaved?.(room.documentId));
    const stored: RoomVersion = new Map(rows.map((row) => [row.docKey, docVersion(row.doc)]));
    return { bytes, docs: rows.length, stored };
  }

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

  function settleIfIdle(loaded: Loaded) {
    if (loaded.saving > 0 || loaded.saveTimer || (loaded.dirty.size > 0 && !loaded.docs.isFreed))
      return;
    loaded.settleSave?.();
    loaded.settleSave = null;
  }

  async function saveUnlessIdle(loaded: Loaded, reason: string) {
    if (loaded.docs.isFreed) return;
    if (reason === "debounce" && loaded.dirty.size === 0) return;
    cancelSave(loaded);
    const started = performance.now();
    let keys = new Set<DocKey>();
    let merged = false;
    let written: Written = NOTHING_WRITTEN;
    try {
      await runOutsideDrizzleTransaction(() =>
        runInDrizzleTransaction(db, async () => {
          const tx = currentDrizzleDb(db);
          await lockRoom(tx, loaded.room);
          if (loaded.docs.isFreed) return;
          const merge = await mergeStored(tx, loaded.name, loaded.docs);
          if (merge) {
            merged = true;
            // What the merge brings reaches the room's sockets and forks like any batch: a tab
            // rejoining resends only what the room lacks, so nobody else would ever get it.
            const result = { changed: merge.changed, pending: false, restore: [] };
            imported(loaded, result, merge.delta, "server:merge", merge.held);
          }
          // Taken here, after the merge and right before the export, so a batch landing during
          // the awaits above is in this save and one landing after it stays dirty for the next.
          keys = loaded.dirty;
          loaded.dirty = new Set();
          cancelSave(loaded);
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
      cancelSave(loaded);
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
          // Live's text docs a fork holds ops of that Live lacks: Apply imports those ops into
          // Live, which throws once Live's history is cut past what they depend on (design §4).
          // The structure is never held: Apply writes Live's structure with ops of its own.
          const held = new Set<DocKey>();
          for (const { draftId } of forks) {
            const fork = { kind: "fork", draftId, documentId: live.documentId } as const;
            const forkName = loroRoomName(fork);
            const stored = await readFrontiers(tx, forkName);
            if (stored.length === 0) continue;
            const docs = await build(tx, fork, liveDocs, freshServerPeerId());
            try {
              for (const [key, doc] of docs.texts) {
                const base = liveDocs.texts.get(key);
                if (!base || !docCovers(docVersion(base), docVersion(doc))) held.add(key);
              }
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
            if (held.has(docKey)) {
              await tx
                .update(documentSnapshots)
                .set({ historyMarkAt: sql`now()` })
                .where(
                  and(eq(documentSnapshots.roomKey, name), eq(documentSnapshots.docKey, docKey)),
                );
              continue;
            }
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

  async function cutRow(
    tx: DrizzleDb,
    roomKey: string,
    docKey: DocKey,
    doc: LoroDoc | undefined,
    mark: StoredFrontiers | undefined,
  ): Promise<number> {
    if (!doc || !mark || mark.length === 0 || !holdsFrontiers(doc, mark)) return 0;
    const shallow = doc.export({ mode: "shallow-snapshot", frontiers: loroFrontiers(mark) });
    const full = doc.export({ mode: "snapshot" });
    const [row] = await tx
      .select({ bytes: sql<number>`octet_length(${documentSnapshots.snapshot})` })
      .from(documentSnapshots)
      .where(and(eq(documentSnapshots.roomKey, roomKey), eq(documentSnapshots.docKey, docKey)));
    const stored = Number(row?.bytes ?? 0);
    const now = storedFrontiers(doc);
    const shrinks = shallow.byteLength < full.byteLength && shallow.byteLength < stored;
    const written = shrinks ? shallow : full;
    await tx
      .update(documentSnapshots)
      .set({
        snapshot: Buffer.from(written.buffer, written.byteOffset, written.byteLength),
        frontiers: now,
        historyMark: now,
        historyMarkAt: sql`now()`,
      })
      .where(and(eq(documentSnapshots.roomKey, roomKey), eq(documentSnapshots.docKey, docKey)));
    return shrinks ? stored - shallow.byteLength : 0;
  }

  async function endLoaded(match: (room: DocumentRoom) => boolean) {
    // A load in flight would register its room after this one ended.
    await Promise.allSettled([...loading.values()]);
    const victims = [...rooms.values()]
      .filter((r) => match(r.room))
      .sort((a, b) => Number(b.room.kind === "fork") - Number(a.room.kind === "fork"));
    for (const loaded of victims) {
      if (loaded.idleTimer) clearTimeout(loaded.idleTimer);
      loaded.idleTimer = null;
      loaded.dirty = new Set();
      cancelSave(loaded);
      if (rooms.get(loaded.name) === loaded) rooms.delete(loaded.name);
      await loaded.queue;
      loaded.docs.free();
      settleIfIdle(loaded);
    }
  }

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
    const live = await copyInTransaction(tx, liveRoomOf(room), freshServerPeerId());
    try {
      const docs = await build(tx, room, live, peer);
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
        let written: Written;
        try {
          const result = copy.importBatch(entries);
          if (result.restore.length) restore = encodeChanges(result.restore);
          written = await writeRows(tx, room, copy, result.changed);
        } finally {
          copy.free();
        }
        const land = () => {
          const loaded = rooms.get(loroRoomName(room));
          if (loaded && !loaded.unloading)
            return void importInto(loaded, batch, origin, written.stored);
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
        let written: Written;
        try {
          written = await writeRows(tx, room, docs, entries.keys());
        } finally {
          docs.free();
        }
        const land = () => {
          const loaded = rooms.get(name);
          if (!loaded || loaded.unloading) return emitTo(room, snapshots, "server:seed");
          importInto(loaded, snapshots, "server:seed", written.stored);
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
      const ending = new Set<string>(documentIds);
      await endLoaded((room) => ending.has(room.documentId));
      await currentDrizzleDb(db).execute(sql`
        delete from document_snapshots s
        where s.room_key in (${sql.join(
          documentIds.map((id) => sql`${`live:${id}`}`),
          sql`, `,
        )})
          and not exists (select 1 from documents d where 'live:' || d.id::text = s.room_key)`);
    },

    async endRooms(ended) {
      const names = new Set(ended.map(loroRoomName));
      if (names.size > 0) await endLoaded((room) => names.has(loroRoomName(room)));
    },

    async retireEmptyForks(now = new Date()) {
      const cutoff = deletionPurgeCutoff(now);
      const due = await runOutsideDrizzleTransaction(() =>
        db
          .select({ draftId: documentForks.draftId, documentId: documentForks.documentId })
          .from(documentForks)
          .where(or(lte(documentForks.checkedAt, cutoff), lte(documentForks.emptySince, cutoff)))
          .orderBy(documentForks.checkedAt)
          .limit(FORK_RETIRE_BATCH),
      );
      let retired = 0;
      for (const { draftId, documentId } of due) {
        const room: ForkRoom = { kind: "fork", draftId, documentId };
        if (rooms.has(loroRoomName(room))) continue;
        const gone = await runOutsideDrizzleTransaction(() =>
          runInDrizzleTransaction(db, async () => {
            const tx = currentDrizzleDb(db);
            await lockRoom(tx, room);
            const docs = await copyInTransaction(tx, room, freshServerPeerId());
            try {
              if (await markFork(tx, room, docs)) await input.onForkPendingChanged?.(draftId);
            } finally {
              docs.free();
            }
            const deleted = await tx
              .delete(documentForks)
              .where(
                and(
                  eq(documentForks.draftId, draftId),
                  eq(documentForks.documentId, documentId),
                  lte(documentForks.emptySince, cutoff),
                ),
              )
              .returning({ draftId: documentForks.draftId });
            if (deleted.length === 0) return false;
            await input.onForkDeleted?.(room);
            return true;
          }),
        );
        if (gone) retired++;
      }
      return retired;
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
