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

/** Resolved provenance by item id. */
class IdMemo {
  private readonly byClient = new Map<number, Map<number, number>>();
  get(client: number, clock: number): number | undefined {
    return this.byClient.get(client)?.get(clock);
  }
  set(client: number, clock: number, who: number) {
    const clocks = this.byClient.get(client);
    if (clocks) clocks.set(clock, who);
    else this.byClient.set(client, new Map([[clock, who]]));
  }
}

/** A frame-local view of indexed evidence. Never share snapshot-dependent memoized decisions. */
export class AttributionEvidence {
  private readonly inserted: IdIndex;
  private readonly deleted: IdIndex;
  private readonly applied: IdIndex;
  private readonly writeBack: IdIndex;
  readonly undone: IdIndex;
  readonly settled: IdIndex;
  private readonly links: IdIndex;
  readonly superseded: IdIndex;
  private readonly linkList: readonly RestorationLink[];
  private readonly originMemo = new IdMemo();
  private readonly writeBackMemo = new IdMemo();
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

  private link(client: number, clock: number): [number, number] | null {
    const l = this.links.get(client, clock);
    if (l < 0) return null;
    const link = this.linkList[l];
    return [link[3], link[4] + (clock - link[1])];
  }

  /**
   * Follows restoration links from an item to the item that wrote it. Links point at earlier items, so
   * the walk ends; what it proves is kept, so a long chain is walked once.
   */
  private chase(
    client: number,
    clock: number,
    memo: IdMemo,
    end: (client: number, clock: number) => number | undefined,
    unlinked: (client: number, clock: number) => number,
  ): number {
    let c = client;
    let k = clock;
    let path: Array<[number, number]> | null = null;
    let who: number;
    for (let hops = 0; ; hops++) {
      const known = memo.get(c, k) ?? end(c, k);
      if (known !== undefined) {
        who = known;
        break;
      }
      const to = this.link(c, k);
      if (!to) {
        who = unlinked(c, k);
        break;
      }
      if (hops > this.linkList.length) {
        who = UNKNOWN;
        break;
      }
      path ??= [];
      path.push([c, k]);
      [c, k] = to;
    }
    if (path) for (const [pc, pk] of path) memo.set(pc, pk, who);
    return who;
  }

  /** `BASE`, `USER`, `UNKNOWN`, or the index of the AI part that wrote the item. */
  origin(client: number, clock: number): number {
    return this.chase(
      client,
      clock,
      this.originMemo,
      (c, k) => {
        if (this.applied.get(c, k) >= 0) return BASE;
        // A restoration link takes precedence over a write-back record: Undo keeps its source.
        if (this.links.get(c, k) < 0 && this.writeBack.get(c, k) >= 0) return BASE;
        const part = this.inserted.get(c, k);
        if (part >= 0) return part;
        return c === DRAFT_SERVER_CLIENT_ID ? BASE : undefined;
      },
      (c, k) =>
        c === this.provenance.localClientId || k < (this.provenance.snapshot.sv.get(c) ?? 0)
          ? USER
          : UNKNOWN,
    );
  }

  /** A Discard copy (including Redo copies), unless Apply has since made it real base. */
  isWriteBack(client: number, clock: number): boolean {
    return (
      this.chase(
        client,
        clock,
        this.writeBackMemo,
        (c, k) => {
          if (this.applied.get(c, k) >= 0) return 0;
          if (this.links.get(c, k) < 0 && this.writeBack.get(c, k) >= 0) return 1;
          return undefined;
        },
        () => 0,
      ) === 1
    );
  }

  /** Undo removed a known Discard base copy, not manuscript text the draft deleted. */
  isUndoneWriteBack(client: number, clock: number): boolean {
    return this.undone.get(client, clock) >= 0 && this.isWriteBack(client, clock);
  }

  /** A pending base tombstone, not an accepted deletion or an old restoration source. */
  isBaseDeletion(client: number, clock: number): boolean {
    return (
      this.settled.get(client, clock) < 0 &&
      !this.isUndoneWriteBack(client, clock) &&
      this.origin(client, clock) === BASE &&
      this.superseded.get(client, clock) < 0
    );
  }

  /** Deletion evidence belongs to this item, never to its restored insertion's source. */
  deleter(client: number, clock: number): number {
    const part = this.deleted.get(client, clock);
    if (part >= 0) return part;
    const id = Y.createID(client, clock);
    return Y.isDeleted(this.provenance.snapshot.ds, id) ||
      (this.provenance.localDeletions && Y.isDeleted(this.provenance.localDeletions, id))
      ? USER
      : UNKNOWN;
  }
}
