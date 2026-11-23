import { decodeImportBlobMeta, type Frontiers, LoroDoc, type LoroText } from "loro-crdt";
import type { Envelope } from "./envelope.js";
import { inText } from "./handles.js";
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
  opsBetween,
  type TextOp,
  type TextSnapshotUnit,
  takeBackMessage,
  textSince,
  textUnitsAt,
} from "./take-back.js";
import {
  type DocVersion,
  docCovers,
  docVersion,
  plainVersion,
  type RoomVersion,
  withVector,
} from "./version.js";
import type { DocChange } from "./write.js";

/** What an import did to a copy (`RoomDocs.importBatch`). */
export interface Imported {
  changed: DocKey[];
  pending: boolean;
  /** The copy's own restore of removals the import brought (design §1, rule 1), to send and save. */
  restore: DocChange | null;
  /** Other untracked writes made while settling an import (currently forward's text take-backs). */
  changes: DocChange[];
}

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
  /** Text docs this copy owns, by block id. */
  readonly texts = new Map<BlockId, LoroDoc>();
  /** Live's copy, for a draft's fork; not owned. */
  readonly live: RoomDocs | null;
  /** A copy of Live this copy made for itself (`fork`, `at`), freed with it. */
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

  /**
   * Calls `listener` each time ops from elsewhere are about to go into this copy (`importBatch`,
   * `forward`): an Undo history takes what its last step left here. Returns the stop.
   */
  beforeImport(listener: () => void): () => void {
    this.importListeners.add(listener);
    return () => this.importListeners.delete(listener);
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

  /** The room version: each owned doc's oplog version. */
  version(): Map<DocKey, DocVersion> {
    const out = new Map<DocKey, DocVersion>();
    for (const [key, doc] of this.owned()) out.set(key, docVersion(doc));
    return out;
  }

  /**
   * The version of every doc a read of this copy shows, as `frontiers()` names them: the room
   * version plus, in a draft, Live's version of each text it has no fork of. A planning view's
   * writes are exported from the room's `shownVersion()` (`view.exportSince(docs.shownVersion())`,
   * design §5): a block the view forked from Live then ships only its new ops, which the draft
   * room imports into its own fork of Live's doc (`importBatch`).
   */
  shownVersion(): Map<DocKey, DocVersion> {
    const out = new Map<DocKey, DocVersion>();
    for (const [key, doc] of this.live?.texts ?? []) out.set(key, docVersion(doc));
    for (const [key, doc] of this.owned()) out.set(key, docVersion(doc));
    return out;
  }

  /** The update of every owned doc that has ops beyond `since` (all of a doc it lacks). */
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
    return { changed, pending, restore: this.answer(before, changed), changes: [] };
  }

  /**
   * Bring a draft's fork up to Live (design §2, "Forwarding"): Live's structure into the structure
   * fork, and each Live text into the fork's own fork of it. A block the fork reads from Live
   * needs nothing. An import like any other (`importBatch`); it never waits on ops.
   */
  forward(options: { settle?: boolean } = {}): Imported {
    const live = this.live;
    if (!live) return { changed: [], pending: false, restore: null, changes: [] };
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
    const settles: TextSettlement[] = [];
    for (const [id, doc] of this.texts) {
      const base = live.textOf(id);
      if (!base) continue;
      if (options.settle) {
        const settlement = prepareTextSettlement(doc, base);
        if (settlement) settles.push({ key: id, ...settlement });
      }
      pull(id, base, doc);
    }
    const settled = options.settle ? settleText(this, live, settles) : [];
    for (const change of settled) changed.push(change.key);
    const restore = this.answer(before, changed);
    return { changed, pending: false, restore, changes: settled };
  }

  private answer(before: Frontiers, changed: readonly DocKey[]): DocChange | null {
    return changed.includes(STRUCTURE_KEY) ? answerRemovals(this, before) : null;
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

type TextHunk = {
  from: number;
  to: number;
  inserted: number;
  deleted: number;
  insertAt: number[];
};

type TextSettlement = {
  key: DocKey;
  at: Frontiers;
  draftBase: TextSnapshotUnit[];
  draftNow: TextSnapshotUnit[];
  liveBase: TextSnapshotUnit[];
  liveNow: TextSnapshotUnit[];
  draftHunks: TextHunk[];
  liveHunks: TextHunk[];
};

/** The shared version and frontier for two copies of one text doc. */
function sharedTextFrontier(a: LoroDoc, b: LoroDoc): Frontiers {
  const av = docVersion(a);
  const bv = docVersion(b);
  const common = new Map<PeerId, number>();
  for (const [peer, counter] of av) {
    const held = Math.min(counter, bv.get(peer) ?? 0);
    if (held > 0) common.set(peer, held);
  }
  return withVector(common, (vector) => a.vvToFrontiers(vector));
}

/** Non-retain runs of a delta, measured as stretches of the shared base text. */
function hunks(delta: readonly TextOp[]): TextHunk[] {
  const out: TextHunk[] = [];
  let base = 0;
  let current: TextHunk | null = null;
  const finish = () => {
    if (current) out.push(current);
    current = null;
  };
  for (const op of delta) {
    if (op.retain != null) {
      finish();
      base += op.retain;
      continue;
    }
    current ??= { from: base, to: base, inserted: 0, deleted: 0, insertAt: [] };
    if (op.delete != null) {
      current.deleted += op.delete;
      current.to += op.delete;
      base += op.delete;
    } else if (op.insert != null) {
      current.inserted += (op.insert as string).length;
      current.insertAt.push(base);
    }
  }
  finish();
  return out;
}

/** Put-back inserts are retained by `textSince`; expose their original stretch for clash rules. */
function putBackHunks(
  base: readonly TextSnapshotUnit[],
  now: readonly TextSnapshotUnit[],
): TextHunk[] {
  const positions = new Map(base.map((unit, index) => [unit.id, index]));
  const baseIds = new Set(base.map((unit) => unit.id));
  const out: TextHunk[] = [];
  for (const unit of now) {
    if (!unit.standsFor || baseIds.has(unit.id)) continue;
    const at = unit.standsFor
      .map((id) => positions.get(id))
      .filter((position): position is number => position !== undefined);
    if (at.length === 0) continue;
    const from = Math.min(...at);
    const to = Math.max(...at) + 1;
    if (!out.some((hunk) => hunk.from === from && hunk.to === to))
      out.push({ from, to, inserted: 1, deleted: 0, insertAt: [from] });
  }
  return out;
}

/** A non-empty hunk overlaps, while an insertion clashes only with a deletion across its place. */
function overlaps(a: TextHunk, b: TextHunk): boolean {
  if (a.from === a.to && b.from === b.to) return false;
  if (a.from === a.to) return b.from < a.from && a.from < b.to;
  if (b.from === b.to) return a.from < b.from && b.from < a.to;
  return Math.max(a.from, b.from) < Math.min(a.to, b.to);
}

function prepareTextSettlement(draft: LoroDoc, live: LoroDoc): Omit<TextSettlement, "key"> | null {
  const at = sharedTextFrontier(draft, live);
  const draftBase = textUnitsAt(draft, at);
  const draftNow = textUnitsAt(draft, draft.frontiers());
  const liveBase = textUnitsAt(live, at);
  const liveNow = textUnitsAt(live, live.frontiers());
  const draftHunks = [...hunks(textSince(draft, at)), ...putBackHunks(draftBase, draftNow)];
  const liveHunks = [...hunks(textSince(live, at)), ...putBackHunks(liveBase, liveNow)];
  if (draftHunks.length === 0 || liveHunks.length === 0) return null;
  if (!liveHunks.some((liveHunk) => draftHunks.some((draftHunk) => overlaps(liveHunk, draftHunk))))
    return null;
  return { at, draftBase, draftNow, liveBase, liveNow, draftHunks, liveHunks };
}

function standsFor(units: readonly TextSnapshotUnit[]): [string, number, number][] {
  const out: [string, number, number][] = [];
  for (const unit of units) {
    const split = unit.id.indexOf("@");
    if (split < 0) continue;
    const peer = unit.id.slice(split + 1);
    const counter = Number(unit.id.slice(0, split));
    const last = out.at(-1);
    if (last && last[0] === peer && last[1] + last[2] === counter) last[2]++;
    else out.push([peer, counter, 1]);
  }
  return out;
}

function insertUnits(text: LoroText, at: number, units: readonly TextSnapshotUnit[]) {
  let pos = at;
  for (const unit of units) {
    text.applyDelta([
      { retain: pos },
      { insert: unit.ch, ...(unit.attributes ? { attributes: unit.attributes } : {}) },
    ]);
    pos++;
  }
}

function settleText(
  docs: RoomDocs,
  live: RoomDocs,
  settlements: readonly TextSettlement[],
): DocChange[] {
  const changes: DocChange[] = [];
  for (const settlement of settlements) {
    const doc = docs.texts.get(settlement.key);
    const liveDoc = live.textOf(settlement.key);
    if (!doc || !liveDoc) continue;
    const clashing = settlement.liveHunks.filter((liveHunk) =>
      settlement.draftHunks.some((draftHunk) => overlaps(liveHunk, draftHunk)),
    );
    if (clashing.length === 0) continue;
    const draftIds = new Set(settlement.draftNow.map((unit) => unit.id));
    const liveBaseIds = new Set(settlement.liveBase.map((unit) => unit.id));
    const liveInserted = new Set<string>();
    const restore: TextSnapshotUnit[] = [];
    for (const hunk of clashing) {
      for (const unit of settlement.liveNow)
        if (
          !liveBaseIds.has(unit.id) &&
          unit.standsFor?.some((id) => {
            const at = settlement.liveBase.findIndex((base) => base.id === id);
            return at >= hunk.from && at < hunk.to;
          })
        )
          liveInserted.add(unit.id);
      let final = 0;
      let base = 0;
      for (const op of textSince(liveDoc, settlement.at)) {
        if (op.retain != null) {
          final += op.retain;
          base += op.retain;
        } else if (op.delete != null) {
          base += op.delete;
        } else if (op.insert != null) {
          if (hunk.insertAt.includes(base))
            for (const unit of settlement.liveNow.slice(
              final,
              final + (op.insert as string).length,
            ))
              liveInserted.add(unit.id);
          final += (op.insert as string).length;
        }
      }
      const deleted = settlement.liveBase.slice(hunk.from, hunk.to);
      for (const unit of deleted) if (draftIds.has(unit.id)) restore.push(unit);
    }
    const before = doc.frontiers();
    inText(doc, (text) => {
      const now = textUnitsAt(doc, doc.frontiers());
      const positions = now
        .map((unit, index) => (liveInserted.has(unit.id) ? index : -1))
        .filter((index) => index >= 0)
        .sort((a, b) => b - a);
      for (const position of positions) text.delete(position, 1);
      if (restore.length === 0) return;
      const current = textUnitsAt(doc, doc.frontiers());
      let insertion = current.length;
      for (let i = settlement.liveBase.length - 1; i >= 0; i--) {
        const pos = current.findIndex((unit) => unit.id === settlement.liveBase[i].id);
        if (pos >= 0) {
          insertion = pos + 1;
          break;
        }
      }
      if (insertion === current.length)
        for (let i = 0; i < settlement.liveBase.length; i++) {
          const pos = current.findIndex((unit) => unit.id === settlement.liveBase[i].id);
          if (pos >= 0) {
            insertion = pos;
            break;
          }
        }
      insertUnits(text, insertion, restore);
    });
    if (sameFrontiers(before, doc.frontiers())) continue;
    const message = takeBackMessage(
      standsFor(restore),
      opsBetween(liveDoc, settlement.at, liveDoc.frontiers()),
    );
    doc.commit({ message });
    changes.push({ key: settlement.key, doc, before, after: doc.frontiers() });
  }
  return changes;
}

/** A fresh peer in `peer`'s range (server or tab), for the Live copy a draft copy owns. */
const peerBeside = (peer: PeerId): PeerId =>
  isServerPeer(peer) ? freshServerPeerId() : freshPeerId();

/** Oplog frontiers move exactly when the oplog gains ops; comparing them needs no version handle. */
function sameFrontiers(a: Frontiers, b: Frontiers): boolean {
  return (
    a.length === b.length &&
    a.every((id) => b.some((other) => other.peer === id.peer && other.counter === id.counter))
  );
}
