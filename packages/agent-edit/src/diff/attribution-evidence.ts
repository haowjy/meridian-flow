/** Receipt and room evidence outlive projections; snapshot decisions and restoration walks do not. */
import * as Y from "yjs";
import { APPLY_RECORD_ROOT, readApplyRecord } from "./apply-record.js";
import { DRAFT_SERVER_CLIENT_ID } from "./draft-base.js";
import { IdIndex, type ItemRange, indexRanges } from "./id-index.js";
import { RESTORED_ROOT, type RestorationLink, readRestorations } from "./restorations.js";

/** One AI write: the item ranges it inserted and deleted. Parts are listed latest first. */
export interface AttributionPart {
  /** Receipt evidence survives deletion of its conversation or turn. Such parts remain members but have no byline. */
  threadId: string | null;
  turnId: string | null;
  toolCallId?: string;
  inserted: readonly ItemRange[];
  deleted: readonly ItemRange[];
}
export interface WriterReceipt {
  userId: string;
  inserted: readonly ItemRange[];
  deleted: readonly ItemRange[];
}
export interface Provenance {
  /** The human who owns the draft's browser clients (`projects.user_id` while a project has one user). */
  userId: string;
  parts: readonly AttributionPart[];
  writers?: readonly WriterReceipt[];
  /** The room revision whose AI parts have been read, including deletion-only writes. */
  snapshot: Y.Snapshot;
  /** Only this browser can positively identify its own unacknowledged insertions. */
  localClientId?: number;
  /** Deletions this browser witnessed in its own local transactions. */
  localDeletions?: Y.Snapshot["ds"];
}
export const BASE = -1;
export const USER = -2;
/** Provenance a restoration chain could not settle. Names no one, and is never the writer's. */
export const UNKNOWN = -3;

const receipts = new WeakMap<readonly AttributionPart[], { inserted: IdIndex; deleted: IdIndex }>();
function receiptEvidence(parts: readonly AttributionPart[]) {
  let evidence = receipts.get(parts);
  if (!evidence) {
    evidence = {
      inserted: indexRanges(parts.map((part) => part.inserted)),
      deleted: indexRanges(parts.map((part) => part.deleted)),
    };
    receipts.set(parts, evidence);
  }
  return evidence;
}

type AppliedEvidence = { applied: IdIndex; settled: IdIndex };
type RestoredEvidence = {
  writeBack: IdIndex;
  undone: IdIndex;
  linkList: readonly RestorationLink[];
  links: IdIndex;
  superseded: IdIndex;
  missing: Map<number, number>;
};
type RoomEvidence = { applied: AppliedEvidence | null; restored: RestoredEvidence | null };
const rooms = new WeakMap<Y.Doc, RoomEvidence>();
function rootChanged(doc: Y.Doc, transaction: Y.Transaction | null, name: string): boolean {
  const root = doc.share.get(name);
  return !!root && !!transaction?.changed.has(root);
}
function roomEvidence(doc: Y.Doc) {
  let evidence = rooms.get(doc);
  if (!evidence) {
    evidence = { applied: null, restored: null };
    rooms.set(doc, evidence);
    const owned = evidence;
    const invalidate = (transaction: Y.Transaction) => {
      // Invalidate before any root observer can project against the new contents.
      if (rootChanged(doc, transaction, APPLY_RECORD_ROOT)) owned.applied = null;
      if (rootChanged(doc, transaction, RESTORED_ROOT)) owned.restored = null;
    };
    doc.on("beforeObserverCalls", invalidate);
    doc.once("destroy", () => doc.off("beforeObserverCalls", invalidate));
  }
  // A caller may classify within the transaction, before root observers have run.
  if (rootChanged(doc, doc._transaction, APPLY_RECORD_ROOT)) evidence.applied = null;
  if (rootChanged(doc, doc._transaction, RESTORED_ROOT)) evidence.restored = null;
  if (!evidence.applied) {
    const record = readApplyRecord(doc);
    evidence.applied = {
      applied: indexRanges([record.flatMap((entry) => entry.base)]),
      settled: indexRanges([record.flatMap((entry) => entry.settled)]),
    };
  }
  // Invalid future references can become valid when their missing clocks arrive, even without a
  // root edit. Normal causally complete records have no dependencies and pay no history scan.
  if (
    evidence.restored &&
    [...evidence.restored.missing].some(([client, end]) => Y.getState(doc.store, client) >= end)
  )
    evidence.restored = null;
  if (!evidence.restored) {
    const missing = new Map<number, number>();
    const restored = readRestorations(doc, (client, end) => {
      missing.set(client, Math.min(missing.get(client) ?? end, end));
    });
    evidence.restored = {
      writeBack: indexRanges([restored.base]),
      undone: indexRanges([restored.undone]),
      linkList: restored.links,
      links: new IdIndex(restored.links.map((link, i) => [link[0], link[1], link[2], i] as const)),
      superseded: indexRanges([restored.links.map((link) => [link[3], link[4], link[2]] as const)]),
      missing,
    };
  }
  return { ...evidence.applied, ...evidence.restored };
}

type EvidenceRun = readonly [value: number, length: number];

/** Whether an id is deleted, and how many ids keep that answer. */
function deletionRun(
  ds: Provenance["snapshot"]["ds"],
  client: number,
  clock: number,
): readonly [boolean, number] {
  const ranges = ds.clients.get(client);
  if (!ranges) return [false, Number.POSITIVE_INFINITY];
  let a = 0;
  let b = ranges.length;
  while (a < b) {
    const m = (a + b) >>> 1;
    if (ranges[m].clock <= clock) a = m + 1;
    else b = m;
  }
  const previous = ranges[a - 1];
  if (previous && clock < previous.clock + previous.len)
    return [true, previous.clock + previous.len - clock];
  return [false, ranges[a] === undefined ? Number.POSITIVE_INFINITY : ranges[a].clock - clock];
}

/** A frame-local view of indexed evidence. Never share snapshot-dependent memoized decisions. */
export class AttributionEvidence {
  private readonly inserted: IdIndex;
  private readonly deleted: IdIndex;
  private readonly applied: IdIndex;
  private readonly writeBack: IdIndex;
  private readonly undone: IdIndex;
  private readonly settled: IdIndex;
  private readonly links: IdIndex;
  private readonly superseded: IdIndex;
  private readonly linkList: readonly RestorationLink[];
  constructor(
    doc: Y.Doc,
    private readonly provenance: Provenance,
  ) {
    const receipts = receiptEvidence(provenance.parts);
    const room = roomEvidence(doc);
    this.inserted = receipts.inserted;
    this.deleted = receipts.deleted;
    this.applied = room.applied;
    this.settled = room.settled;
    this.writeBack = room.writeBack;
    this.undone = room.undone;
    this.linkList = room.linkList;
    this.links = room.links;
    this.superseded = room.superseded;
  }

  /** Resolve one homogeneous origin run, following restoration intervals with the same offset. */
  private originRun(client: number, clock: number, length: number): EvidenceRun {
    let c = client;
    let k = clock;
    let available = length;
    for (let hops = 0; ; hops++) {
      const [applied, appliedLength] = this.applied.run(c, k);
      available = Math.min(available, appliedLength);
      if (applied >= 0) return [BASE, available];
      const [linkAt, linkLength] = this.links.run(c, k);
      available = Math.min(available, linkLength);
      const [writeBack, writeBackLength] = this.writeBack.run(c, k);
      available = Math.min(available, writeBackLength);
      if (linkAt < 0 && writeBack >= 0) return [BASE, available];
      const [part, partLength] = this.inserted.run(c, k);
      available = Math.min(available, partLength);
      if (part >= 0) return [part, available];
      if (c === DRAFT_SERVER_CLIENT_ID) return [BASE, available];
      if (linkAt < 0) {
        const seen = this.provenance.snapshot.sv.get(c) ?? 0;
        if (c === this.provenance.localClientId) return [USER, available];
        if (k < seen) return [USER, Math.min(available, seen - k)];
        return [UNKNOWN, available];
      }
      if (hops > this.linkList.length) return [UNKNOWN, available];
      const link = this.linkList[linkAt];
      c = link[3];
      k = link[4] + (k - link[1]);
    }
  }

  /** `BASE`, `USER`, `UNKNOWN`, or the index of the AI part that wrote the item. */
  origin(client: number, clock: number): number {
    return this.originRun(client, clock, 1)[0];
  }

  origins(
    client: number,
    clock: number,
    length: number,
    visit: (who: number, clock: number, length: number) => void,
  ) {
    for (let offset = 0; offset < length; ) {
      const [who, run] = this.originRun(client, clock + offset, length - offset);
      visit(who, clock + offset, run);
      offset += run;
    }
  }

  private writeBackRun(client: number, clock: number, length: number): EvidenceRun {
    let c = client;
    let k = clock;
    let available = length;
    for (let hops = 0; ; hops++) {
      const [applied, appliedLength] = this.applied.run(c, k);
      available = Math.min(available, appliedLength);
      if (applied >= 0) return [0, available];
      const [linkAt, linkLength] = this.links.run(c, k);
      available = Math.min(available, linkLength);
      const [writeBack, writeBackLength] = this.writeBack.run(c, k);
      available = Math.min(available, writeBackLength);
      if (linkAt < 0) return [writeBack >= 0 ? 1 : 0, available];
      if (hops > this.linkList.length) return [0, available];
      const link = this.linkList[linkAt];
      c = link[3];
      k = link[4] + (k - link[1]);
    }
  }

  /** Whether every id is a known Undo removal of a Discard base copy. */
  isAllUndoneWriteBack(client: number, clock: number, length: number): boolean {
    for (let offset = 0; offset < length; ) {
      const at = clock + offset;
      const [undone, undoneLength] = this.undone.run(client, at);
      const [writeBack, writeBackLength] = this.writeBackRun(client, at, length - offset);
      if (undone < 0 || writeBack !== 1) return false;
      offset += Math.min(length - offset, undoneLength, writeBackLength);
    }
    return true;
  }

  /** Deletion evidence belongs to this item, never to its restored insertion's source. */
  deleter(client: number, clock: number): number {
    return this.deleterRun(client, clock, 1)[0];
  }

  private deleterRun(client: number, clock: number, length: number): EvidenceRun {
    const [part, partLength] = this.deleted.run(client, clock);
    if (part >= 0) return [part, Math.min(length, partLength)];
    const [deleted, deletedLength] = deletionRun(this.provenance.snapshot.ds, client, clock);
    const [local, localLength] = this.provenance.localDeletions
      ? deletionRun(this.provenance.localDeletions, client, clock)
      : ([false, Number.POSITIVE_INFINITY] as const);
    return [
      deleted || local ? USER : UNKNOWN,
      Math.min(length, partLength, deletedLength, localLength),
    ];
  }

  /** Current-id deletion evidence, partitioned by accepted and pending intervals. */
  deletions(
    client: number,
    clock: number,
    length: number,
    visit: (who: number, settled: boolean, clock: number, length: number) => void,
  ) {
    for (let offset = 0; offset < length; ) {
      const at = clock + offset;
      const [settled, settledLength] = this.settled.run(client, at);
      const [who, deleterLength] = this.deleterRun(client, at, length - offset);
      const run = Math.min(length - offset, settledLength, deleterLength);
      visit(who, settled >= 0, at, run);
      offset += run;
    }
  }

  /** Pending base tombstones and their deleters, in homogeneous runs. */
  baseDeletions(
    client: number,
    clock: number,
    length: number,
    visit: (who: number, length: number) => void,
  ) {
    for (let offset = 0; offset < length; ) {
      const at = clock + offset;
      const [settled, settledLength] = this.settled.run(client, at);
      const [undone, undoneLength] = this.undone.run(client, at);
      const [writeBack, writeBackLength] = this.writeBackRun(client, at, length - offset);
      const [origin, originLength] = this.originRun(client, at, length - offset);
      const [superseded, supersededLength] = this.superseded.run(client, at);
      const [who, deleterLength] = this.deleterRun(client, at, length - offset);
      const run = Math.min(
        length - offset,
        settledLength,
        undoneLength,
        writeBackLength,
        originLength,
        supersededLength,
        deleterLength,
      );
      if (settled < 0 && !(undone >= 0 && writeBack === 1) && origin === BASE && superseded < 0)
        visit(who, run);
      offset += run;
    }
  }
}
