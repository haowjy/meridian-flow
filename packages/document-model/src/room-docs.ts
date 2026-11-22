import { decodeImportBlobMeta, type Frontiers, LoroDoc, VersionVector } from "loro-crdt";
import { decodeEnvelope, type Envelope, encodeEnvelope } from "./envelope.js";
import type { PeerId } from "./peer.js";
import {
  type BlockId,
  configureDoc,
  type DocKey,
  type ShapeSchema,
  STRUCTURE_KEY,
} from "./shape.js";

/** A `RoomDocs` used after `free()`: a bug in the caller's order (destroy the editor, then free). */
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

function checkBytes(key: DocKey, bytes: Uint8Array, snapshot: boolean) {
  let mode: string;
  try {
    mode = decodeImportBlobMeta(bytes, true).mode;
  } catch (error) {
    throw new CorruptDocBytesError(key, `not Loro bytes, or a failed checksum (${String(error)})`);
  }
  if (snapshot && mode !== "snapshot" && mode !== "shallow-snapshot")
    throw new CorruptDocBytesError(key, `a snapshot row holds a Loro ${mode}`);
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
  /** Text docs this copy owns, by block id. */
  readonly texts = new Map<BlockId, LoroDoc>();
  /** Live's copy, for a draft's fork; not owned. */
  readonly live: RoomDocs | null;
  /** A copy of Live this copy made for itself (`fork`, `at`), freed with it. */
  private ownedLive: RoomDocs | null = null;
  private freed = false;

  private constructor(shape: ShapeSchema, peer: PeerId, structure: LoroDoc, live: RoomDocs | null) {
    this.shape = shape;
    this.peer = peer;
    this.structureDoc = this.adopt(structure);
    this.live = live;
  }

  /** An empty Live copy. */
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

  /** A new draft fork of `live`: its structure forked, no text of its own yet. */
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
   * touching the room's); `free()` on the result frees that too.
   */
  fork(peer: PeerId): RoomDocs {
    const live = this.live?.fork(peer) ?? null;
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
   * throws. A text doc the frontiers do not name did not exist at the read and is left out. In a
   * draft, the copy has its own copy of Live holding Live's texts at their frontiers. Not forwarded;
   * the caller frees it.
   */
  at(frontiers: ReadonlyMap<DocKey, Frontiers>, peer: PeerId): RoomDocs {
    const view = (doc: LoroDoc, at: Frontiers) => {
      const copy = doc.fork();
      copy.checkout(at);
      copy.setDetachedEditing(true);
      return copy;
    };
    const structureAt = frontiers.get(STRUCTURE_KEY) ?? [];
    const live = this.live
      ? new RoomDocs(this.shape, peer, this.live.structure.fork(), null)
      : null;
    const copy = new RoomDocs(this.shape, peer, view(this.structure, structureAt), live);
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

  /** The doc a reader reads a block's text from: its own, else Live's for a draft. */
  textOf(id: BlockId): LoroDoc | undefined {
    this.alive();
    return this.texts.get(id) ?? this.live?.textOf(id);
  }

  /**
   * The doc a write into block `id` goes to: its own, else (in a draft) a fork of Live's taken now,
   * else a new doc. A draft never writes into Live's text docs. `before` is the frontier the write
   * starts from: the doc's own, or for a doc forked by this call the frontier it forked at, which
   * is what the write's Undo record and a turn's `Restore before` need (design §2).
   */
  writableText(id: BlockId): { doc: LoroDoc; before: Frontiers } {
    const own = this.texts.get(id);
    if (own) return { doc: own, before: own.frontiers() };
    const base = this.live?.textOf(id);
    const doc = this.adopt(base ? base.fork() : new LoroDoc());
    const before = base ? base.frontiers() : doc.frontiers();
    this.texts.set(id, doc);
    return { doc, before };
  }

  /** The owned doc of `key`. */
  doc(key: DocKey): LoroDoc | undefined {
    return key === STRUCTURE_KEY ? this.structure : this.texts.get(key);
  }

  /** Every doc this copy owns, by doc key. */
  *owned(): Iterable<[DocKey, LoroDoc]> {
    yield [STRUCTURE_KEY, this.structure];
    yield* this.texts;
  }

  /** The room version: each owned doc's oplog version vector. */
  version(): Map<DocKey, VersionVector> {
    const out = new Map<DocKey, VersionVector>();
    for (const [key, doc] of this.owned()) out.set(key, doc.oplogVersion());
    return out;
  }

  /** The update of every owned doc that has ops beyond `since` (all of a doc it lacks). */
  exportSince(since: ReadonlyMap<DocKey, VersionVector> = new Map()): Map<DocKey, Uint8Array> {
    const out = new Map<DocKey, Uint8Array>();
    for (const [key, doc] of this.owned()) {
      const from = since.get(key);
      const order = from ? doc.oplogVersion().compare(from) : 1;
      if (order === 0 || order === -1) continue;
      out.set(key, doc.export(from ? { mode: "update", from } : { mode: "update" }));
    }
    return out;
  }

  /** A snapshot per owned doc, for `document_snapshots` rows. */
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
   * Import a batch, as one: every entry is checked first (`CorruptDocBytesError`), so a batch
   * with a bad entry imports nothing and creates no doc. A doc key this copy has no doc for (a
   * block another copy created or first wrote) gets one: in a draft a fork of Live's doc of that
   * key when Live has one, else empty, so a fork's first write into a block lands rather than
   * staying pending (design §4). Returns the keys that changed and whether any import is pending
   * on ops not yet seen.
   */
  importBatch(batch: Envelope): { changed: DocKey[]; pending: boolean } {
    this.alive();
    for (const [key, bytes] of batch) checkBytes(key, bytes, false);
    const changed: DocKey[] = [];
    let pending = false;
    for (const [key, bytes] of batch) {
      let doc = this.doc(key);
      if (!doc) {
        const base = this.live?.textOf(key);
        doc = this.adopt(base ? base.fork() : new LoroDoc());
        this.texts.set(key, doc);
      }
      const before = doc.oplogVersion();
      const status = doc.import(bytes);
      if (status.pending) pending = true;
      if (doc.oplogVersion().compare(before) !== 0) changed.push(key);
    }
    return { changed, pending };
  }

  /**
   * Bring a draft's fork up to Live (design §2, "Forwarding"): Live's structure into the structure
   * fork, and each Live text into the fork's own fork of it. A block the fork reads from Live
   * needs nothing. Returns the doc keys that changed.
   */
  forward(): DocKey[] {
    const live = this.live;
    if (!live) return [];
    const changed: DocKey[] = [];
    const pull = (key: DocKey, from: LoroDoc, into: LoroDoc) => {
      const before = into.oplogVersion();
      into.import(from.export({ mode: "update", from: before }));
      if (into.oplogVersion().compare(before) !== 0) changed.push(key);
    };
    pull(STRUCTURE_KEY, live.structure, this.structure);
    for (const [id, doc] of this.texts) {
      const base = live.textOf(id);
      if (base) pull(id, base, doc);
    }
    return changed;
  }

  free(): void {
    if (this.freed) return;
    this.structureDoc.free();
    for (const doc of this.texts.values()) doc.free();
    this.texts.clear();
    this.ownedLive?.free();
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

/** A room version as `JoinRequest`/`JoinResponseOk` carry it: an envelope of encoded vectors. */
export function encodeRoomVersion(version: ReadonlyMap<DocKey, VersionVector>): Uint8Array {
  return encodeEnvelope(new Map([...version].map(([key, vv]) => [key, vv.encode()])));
}

export function decodeRoomVersion(bytes: Uint8Array): Map<DocKey, VersionVector> {
  if (bytes.length === 0) return new Map();
  return new Map([...decodeEnvelope(bytes)].map(([key, vv]) => [key, VersionVector.decode(vv)]));
}
