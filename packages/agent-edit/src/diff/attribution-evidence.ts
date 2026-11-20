/** Receipt evidence outlives projections; snapshot decisions do not. */
import type * as Y from "yjs";
import { DRAFT_SERVER_CLIENT_ID } from "./draft-base.js";
import { type IdIndex, type ItemRange, indexRanges } from "./id-index.js";

/** One AI write: the item ranges it inserted and deleted. Parts are listed latest first. */
export interface AttributionPart {
  /** Receipt evidence survives deletion of its conversation or turn. Such parts remain members but have no byline. */
  threadId: string | null;
  turnId: string | null;
  toolCallId?: string;
  inserted: readonly ItemRange[];
  deleted: readonly ItemRange[];
  /** An Undo took the part out: its tombstones are history, no pending change's evidence. */
  taken?: boolean;
  /**
   * An Apply in force carried every change of the part (the server's record of the Apply): its
   * text is the base's now, and its deletions are settled.
   */
  applied?: boolean;
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

const receipts = new WeakMap<
  readonly AttributionPart[],
  { inserted: IdIndex; deleted: IdIndex; taken: IdIndex; applied: IdIndex }
>();
function receiptEvidence(parts: readonly AttributionPart[]) {
  let evidence = receipts.get(parts);
  if (!evidence) {
    evidence = {
      inserted: indexRanges(parts.map((part) => part.inserted)),
      deleted: indexRanges(parts.map((part) => part.deleted)),
      taken: indexRanges([
        parts.flatMap((part) =>
          part.taken ? [...part.inserted, ...part.deleted] : part.applied ? part.deleted : [],
        ),
      ]),
      applied: indexRanges([parts.filter((part) => part.applied).flatMap((part) => part.inserted)]),
    };
    receipts.set(parts, evidence);
  }
  return evidence;
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
  private readonly taken: IdIndex;
  private readonly applied: IdIndex;
  constructor(private readonly provenance: Provenance) {
    const receipts = receiptEvidence(provenance.parts);
    this.inserted = receipts.inserted;
    this.deleted = receipts.deleted;
    this.taken = receipts.taken;
    this.applied = receipts.applied;
  }

  /** Resolve one homogeneous origin run. */
  private originRun(client: number, clock: number, length: number): EvidenceRun {
    const [applied, appliedLength] = this.applied.run(client, clock);
    if (applied >= 0) return [BASE, Math.min(length, appliedLength)];
    const [part, partLength] = this.inserted.run(client, clock);
    const available = Math.min(length, partLength, appliedLength);
    if (part >= 0) return [part, available];
    if (client === DRAFT_SERVER_CLIENT_ID) return [BASE, available];
    const seen = this.provenance.snapshot.sv.get(client) ?? 0;
    if (client === this.provenance.localClientId) return [USER, available];
    if (clock < seen) return [USER, Math.min(available, seen - clock)];
    return [UNKNOWN, available];
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

  /** Whether an Undo took the id's part out, or an Apply took all of it: no pending change's evidence. */
  private settledRun(client: number, clock: number): EvidenceRun {
    return this.taken.run(client, clock);
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
      const [settled, settledLength] = this.settledRun(client, at);
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
      const [settled, settledLength] = this.settledRun(client, at);
      const [origin, originLength] = this.originRun(client, at, length - offset);
      const [who, deleterLength] = this.deleterRun(client, at, length - offset);
      const run = Math.min(length - offset, settledLength, originLength, deleterLength);
      if (settled < 0 && origin === BASE) visit(who, run);
      offset += run;
    }
  }
}
