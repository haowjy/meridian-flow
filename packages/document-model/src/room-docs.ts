import { decodeImportBlobMeta, type Frontiers, LoroDoc } from "loro-crdt";
import type { Envelope } from "./envelope.js";
import { freshPeerId, freshServerPeerId, isServerPeer, type PeerId } from "./peer.js";
import { answerRemovals } from "./removals.js";
import {
  type BlockId,
  configureDoc,
  type DocKey,
  type ShapeSchema,
  STRUCTURE_KEY,
} from "./shape.js";
import {
  type DocVersion,
  docCovers,
  docVersion,
  plainVersion,
  type RoomVersion,
  withVector,
} from "./version.js";
import type { DocChange } from "./write.js";

export interface Imported {
  changed: DocKey[];
  pending: boolean;
  restore: DocChange[];
}

export class RoomDocsFreedError extends Error {
  constructor() {
    super("RoomDocs used after free()");
    this.name = "RoomDocsFreedError";
  }
}

/**
 * Bytes for one doc of a batch or a load that are not a Loro update or snapshot, or fail its
 * checksum (`LORO_ROOM_ERROR.CORRUPT_UPDATE`). Thrown before anything is imported or created.
 */
export class CorruptDocBytesError extends Error {
  constructor(
    readonly key: DocKey,
    reason: string,
  ) {
    super(`doc ${key}: ${reason}`);
    this.name = "CorruptDocBytesError";
  }
}

/**
 * An update for one doc of a batch that depends on history below that doc's shallow cutoff (a tab
 * offline past the cutoff, design §4: `LORO_ROOM_ERROR.HISTORY_CUTOFF`). Thrown before anything
 * is imported or created.
 */
export class HistoryCutoffError extends Error {
  constructor(
    readonly key: DocKey,
    reason: string,
  ) {
    super(`doc ${key}: depends on history below the shallow cutoff (${reason})`);
    this.name = "HistoryCutoffError";
  }
}

type BytesMeta = { startFrontiers: Frontiers; end: DocVersion };

function checkBytes(key: DocKey, bytes: Uint8Array, snapshot: boolean): BytesMeta {
  let meta: ReturnType<typeof decodeImportBlobMeta>;
  try {
    meta = decodeImportBlobMeta(bytes, true);
  } catch (error) {
    throw new CorruptDocBytesError(key, `not Loro bytes, or a failed checksum (${String(error)})`);
  }
  meta.partialStartVersionVector.free();
  const end = plainVersion(meta.partialEndVersionVector);
  if (snapshot && meta.mode !== "snapshot" && meta.mode !== "shallow-snapshot")
    throw new CorruptDocBytesError(key, `a snapshot row holds a Loro ${meta.mode}`);
  return { startFrontiers: meta.startFrontiers, end };
}

/**
 * Throws `HistoryCutoffError` if `doc` would refuse `bytes` for depending on history below its
 * shallow cutoff. The metadata clears every update that starts at or after the cutoff, or brings
 * nothing `doc` lacks. One that starts below it may still land, when its ops below the cutoff are
 * ones `doc` already has and its new ops depend only on ops after it (a tab that rejoined and
 * sends from an old version); the metadata cannot tell that from a stale tab's offline typing, so
 * only that case is settled by importing into a fork.
 */
function checkCutoff(key: DocKey, doc: LoroDoc, bytes: Uint8Array, meta: BytesMeta) {
  if (!doc.isShallow()) return;
  if (docCovers(docVersion(doc), meta.end)) return;
  const since = plainVersion(doc.shallowSinceVV());
  const roots = doc.shallowSinceFrontiers();
  const belowCutoff =
    meta.startFrontiers.length === 0 ||
    meta.startFrontiers.some(
      (id) =>
        id.counter < (since.get(id.peer) ?? 0) &&
        !roots.some((root) => root.peer === id.peer && root.counter === id.counter),
    );
  if (!belowCutoff) return;
  const trial = doc.fork();
  try {
    trial.import(bytes);
  } catch (error) {
    throw new HistoryCutoffError(key, String(error));
  } finally {
    trial.free();
  }
}

/**
 * One copy of a document room's docs (design §1): the structure doc and the text docs this copy
 * owns. A draft's fork (`live` set) owns the structure fork and the text forks of the blocks the
 * draft wrote, and reads every other block's text from Live's copy.
 *
 * Ownership: whoever creates a `RoomDocs` calls `free()` on it, which frees the structure and the
 * owned text docs, never `live`. A `LoroDoc` is WASM memory that no garbage collector reclaims.
 * Any use after `free()` throws `RoomDocsFreedError`.
 */
export class RoomDocs {
  readonly shape: ShapeSchema;
  readonly peer: PeerId;
  private readonly structureDoc: LoroDoc;
  readonly texts = new Map<BlockId, LoroDoc>();
  readonly live: RoomDocs | null;
  private ownedLive: RoomDocs | null = null;
  private readonly textWriteListeners = new Set<(id: BlockId, doc: LoroDoc) => void>();
  private readonly importListeners = new Set<() => void>();
  private freed = false;

  private constructor(shape: ShapeSchema, peer: PeerId, structure: LoroDoc, live: RoomDocs | null) {
    // A press writes both rooms from one draft copy: two docs of one history written under one
    // peer would mint the same op ids.
    if (live?.peer === peer) throw new Error(`a draft copy and its Live copy share peer ${peer}`);
    this.shape = shape;
    this.peer = peer;
    this.structureDoc = this.adopt(structure);
    this.live = live;
  }

  static create(shape: ShapeSchema, peer: PeerId): RoomDocs {
    return new RoomDocs(shape, peer, new LoroDoc(), null);
  }

  /**
   * A copy loaded from snapshots by doc key (`document_snapshots` rows, which an older build may
   * have written). Every row is checked before any doc is made, and a load that fails frees what
   * it made. With `live`, a draft's fork: a missing structure row means the fork has no state of
   * its own yet and starts as a fork of Live's.
   */
  static load(
    shape: ShapeSchema,
    peer: PeerId,
    snapshots: Envelope,
    live: RoomDocs | null = null,
  ): RoomDocs {
    for (const [key, bytes] of snapshots) checkBytes(key, bytes, true);
    const bytes = snapshots.get(STRUCTURE_KEY);
    const structure = bytes
      ? LoroDoc.fromSnapshot(bytes)
      : live
        ? live.structure.fork()
        : new LoroDoc();
    const docs = new RoomDocs(shape, peer, structure, live);
    try {
      for (const [key, data] of snapshots)
        if (key !== STRUCTURE_KEY) docs.texts.set(key, docs.adopt(LoroDoc.fromSnapshot(data)));
    } catch (error) {
      docs.free();
      throw error;
    }
    return docs;
  }

  static draftOf(live: RoomDocs, peer: PeerId): RoomDocs {
    return new RoomDocs(live.shape, peer, live.structure.fork(), live);
  }

  get structure(): LoroDoc {
    this.alive();
    return this.structureDoc;
  }

  get draft(): boolean {
    return this.live !== null;
  }

  get isFreed(): boolean {
    return this.freed;
  }

  /**
   * A private copy of these docs under `peer`, for a command or a read to change and drop. A
   * draft's copy comes with its own copy of `live` (so it can be forwarded and pressed without
   * touching the room's); `free()` on the result frees that too. That Live copy takes its own
   * fresh peer in `peer`'s range.
   */
  fork(peer: PeerId): RoomDocs {
    const live = this.live?.fork(peerBeside(peer)) ?? null;
    const copy = new RoomDocs(this.shape, peer, this.structure.fork(), live);
    copy.ownedLive = live;
    for (const [id, doc] of this.texts) copy.texts.set(id, copy.adopt(doc.fork()));
    return copy;
  }

  /**
   * The frontiers of every doc a read of this copy shows: the structure and each block's text doc,
   * Live's where a draft has none of its own. A read that shows a document to the model records
   * these to plan its writes on later (`at`, design §5).
   */
  frontiers(): Map<DocKey, Frontiers> {
    const out = new Map<DocKey, Frontiers>([[STRUCTURE_KEY, this.structure.frontiers()]]);
    for (const [key, doc] of this.live?.texts ?? []) out.set(key, doc.frontiers());
    for (const [key, doc] of this.texts) out.set(key, doc.frontiers());
    return out;
  }

  /**
   * A copy of these docs as they read at `frontiers` (from `frontiers()`, possibly with a writer's
   * own commit heads merged in), under `peer`, to plan a write on what its reader saw. Its writes
   * depend on exactly those frontiers, so exported from this copy's version they merge as an
   * offline peer's edit. Each doc is `fork().checkout(frontiers)` with detached editing on, which
   * works on a doc compacted to a shallow snapshot where `forkAt` does not (design §4); the
   * caller checks first that each frontier is in its doc and not below the cutoff, or this
   * throws, having made nothing. A text doc the frontiers do not name did not exist at the read and
   * is left out. In a draft, the copy has its own copy of Live holding Live's texts at their
   * frontiers, with an empty structure: a draft reads its structure from its own fork. Not
   * forwarded; the caller frees it. Export its writes from the `shownVersion()` of the copy it was
   * made from, not the view's own version, which would ship a forked block's whole history.
   */
  at(frontiers: ReadonlyMap<DocKey, Frontiers>, peer: PeerId): RoomDocs {
    const view = (doc: LoroDoc, at: Frontiers) => {
      const copy = doc.fork();
      try {
        copy.checkout(at);
      } catch (error) {
        copy.free();
        throw error;
      }
      copy.setDetachedEditing(true);
      return copy;
    };
    const structure = view(this.structure, frontiers.get(STRUCTURE_KEY) ?? []);
    const live = this.live ? new RoomDocs(this.shape, peerBeside(peer), new LoroDoc(), null) : null;
    const copy = new RoomDocs(this.shape, peer, structure, live);
    copy.ownedLive = live;
    try {
      for (const [key, at] of frontiers) {
        if (key === STRUCTURE_KEY) continue;
        const own = this.texts.get(key);
        const base = own ? null : this.live?.texts.get(key);
        if (own) copy.texts.set(key, copy.adopt(view(own, at)));
        else if (base && live) live.texts.set(key, live.adopt(view(base, at)));
      }
    } catch (error) {
      copy.free();
      throw error;
    }
    return copy;
  }

  textOf(id: BlockId): LoroDoc | undefined {
    this.alive();
    return this.texts.get(id) ?? this.live?.textOf(id);
  }

  textKeys(): Set<BlockId> {
    this.alive();
    return new Set([...(this.live?.textKeys() ?? []), ...this.texts.keys()]);
  }

  writableText(id: BlockId): { doc: LoroDoc; before: Frontiers } {
    const own = this.texts.get(id);
    let written: { doc: LoroDoc; before: Frontiers };
    if (own) written = { doc: own, before: own.frontiers() };
    else {
      const base = this.live?.textOf(id);
      const doc = this.adopt(base ? base.fork() : new LoroDoc());
      written = { doc, before: base ? base.frontiers() : doc.frontiers() };
      this.texts.set(id, doc);
    }
    for (const listener of this.textWriteListeners) listener(id, written.doc);
    return written;
  }

  /**
   * Calls `listener` with the doc each time a local write is about to go into a text doc (every
   * `writableText`), before its first op: a Loro `UndoManager` records only commits made after it
   * exists, so an Undo history starts watching a doc here. Returns the stop.
   */
  beforeTextWrite(listener: (id: BlockId, doc: LoroDoc) => void): () => void {
    this.textWriteListeners.add(listener);
    return () => this.textWriteListeners.delete(listener);
  }

  beforeImport(listener: () => void): () => void {
    this.importListeners.add(listener);
    return () => this.importListeners.delete(listener);
  }

  doc(key: DocKey): LoroDoc | undefined {
    return key === STRUCTURE_KEY ? this.structure : this.texts.get(key);
  }

  *owned(): Iterable<[DocKey, LoroDoc]> {
    yield [STRUCTURE_KEY, this.structure];
    yield* this.texts;
  }

  version(): Map<DocKey, DocVersion> {
    const out = new Map<DocKey, DocVersion>();
    for (const [key, doc] of this.owned()) out.set(key, docVersion(doc));
    return out;
  }

  shownVersion(): Map<DocKey, DocVersion> {
    const out = new Map<DocKey, DocVersion>();
    for (const [key, doc] of this.live?.texts ?? []) out.set(key, docVersion(doc));
    for (const [key, doc] of this.owned()) out.set(key, docVersion(doc));
    return out;
  }

  exportSince(since: RoomVersion = new Map()): Map<DocKey, Uint8Array> {
    const out = new Map<DocKey, Uint8Array>();
    for (const [key, doc] of this.owned()) {
      const from = since.get(key);
      if (!from) out.set(key, doc.export({ mode: "update" }));
      else if (!docCovers(from, docVersion(doc)))
        out.set(
          key,
          withVector(from, (vector) => doc.export({ mode: "update", from: vector })),
        );
    }
    return out;
  }

  snapshots(
    keys: Iterable<DocKey> = [...this.owned()].map(([key]) => key),
  ): Map<DocKey, Uint8Array> {
    const out = new Map<DocKey, Uint8Array>();
    for (const key of keys) {
      const doc = this.doc(key);
      if (doc) out.set(key, doc.export({ mode: "snapshot" }));
    }
    return out;
  }

  /**
   * Import a batch, as one: every entry is checked first, so a batch with an entry that is not
   * Loro bytes (`CorruptDocBytesError`) or depends on history below its doc's shallow cutoff
   * (`HistoryCutoffError`) imports nothing and creates no doc. A doc key this copy has no doc for (a
   * block another copy created or first wrote) gets one: in a draft a fork of Live's doc of that
   * key when Live has one, else empty, so a fork's first write into a block lands rather than
   * staying pending (design §4).
   *
   * Every import into a copy comes here, so every copy answers a removal before anything reads
   * it (design §1, "Removed blocks", rule 1): a removal the batch brought that did not read text
   * this copy holds is restored. Returns the keys that changed, whether any import is pending on
   * ops not yet seen, and the restore this copy wrote, which its holder sends and saves like a
   * local write.
   */
  importBatch(batch: Envelope): Imported {
    this.alive();
    for (const [key, bytes] of batch) {
      const meta = checkBytes(key, bytes, false);
      const target = this.doc(key) ?? this.live?.textOf(key);
      if (target) checkCutoff(key, target, bytes, meta);
    }
    for (const listener of this.importListeners) listener();
    const before = this.structureDoc.frontiers();
    const changed: DocKey[] = [];
    let pending = false;
    for (const [key, bytes] of batch) {
      let doc = this.doc(key);
      if (!doc) {
        const base = this.live?.textOf(key);
        doc = this.adopt(base ? base.fork() : new LoroDoc());
        this.texts.set(key, doc);
      }
      const at = doc.oplogFrontiers();
      const status = doc.import(bytes);
      if (status.pending) pending = true;
      if (!sameFrontiers(doc.oplogFrontiers(), at)) changed.push(key);
    }
    return { changed, pending, restore: this.answer(before, changed) };
  }

  forward(): Imported {
    const live = this.live;
    if (!live) return { changed: [], pending: false, restore: [] };
    for (const listener of this.importListeners) listener();
    const before = this.structureDoc.frontiers();
    const changed: DocKey[] = [];
    const pull = (key: DocKey, from: LoroDoc, into: LoroDoc) => {
      const at = into.oplogFrontiers();
      const update = withVector(docVersion(into), (vector) =>
        from.export({ mode: "update", from: vector }),
      );
      into.import(update);
      if (!sameFrontiers(into.oplogFrontiers(), at)) changed.push(key);
    };
    pull(STRUCTURE_KEY, live.structure, this.structure);
    for (const [id, doc] of this.texts) {
      const base = live.textOf(id);
      if (base) pull(id, base, doc);
    }
    return { changed, pending: false, restore: this.answer(before, changed) };
  }

  private answer(before: Frontiers, changed: DocKey[]): DocChange[] {
    if (!changed.includes(STRUCTURE_KEY)) return [];
    const restore = answerRemovals(this, before);
    for (const { key } of restore) if (!changed.includes(key)) changed.push(key);
    return restore;
  }

  free(): void {
    if (this.freed) return;
    this.structureDoc.free();
    for (const doc of this.texts.values()) doc.free();
    this.texts.clear();
    this.ownedLive?.free();
    this.textWriteListeners.clear();
    this.importListeners.clear();
    this.freed = true;
  }

  private alive() {
    if (this.freed) throw new RoomDocsFreedError();
  }

  private adopt(doc: LoroDoc): LoroDoc {
    doc.setPeerId(this.peer);
    return configureDoc(doc, this.shape);
  }
}

const peerBeside = (peer: PeerId): PeerId =>
  isServerPeer(peer) ? freshServerPeerId() : freshPeerId();

function sameFrontiers(a: Frontiers, b: Frontiers): boolean {
  return (
    a.length === b.length &&
    a.every((id) => b.some((other) => other.peer === id.peer && other.counter === id.counter))
  );
}
