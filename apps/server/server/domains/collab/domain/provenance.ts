/** Deterministic safety-provenance facts for checkpoint manifests. */

import type { LineageRange } from "@meridian/agent-edit/integration";
import type { DocumentAuthorityId } from "@meridian/contracts";
import * as Y from "yjs";

export type { DocumentAuthorityId } from "@meridian/contracts";
export type SafetyBirthClass = "writer_protected" | "agent";

export type JournalReplayKey = {
  admissionSequence: bigint;
  batchOrdinal: number;
  journalRowId: bigint;
};

export type AttributionManifestV1 = {
  version: 1;
  authorityId: DocumentAuthorityId;
  checkpointId: string;
  /** The exact retained prefix represented by checkpointUpdate. */
  floor: JournalReplayKey | null;
  attributions: AttributionRunV1[];
};

export type AttributionRunV1 = {
  range: LineageRange;
  birthClass: SafetyBirthClass;
  origin: JournalReplayKey;
};

export type AttributedJournalRow = JournalReplayKey & {
  authorityId: DocumentAuthorityId;
  originType: string | null;
  actorUserId: string | null;
  update: Uint8Array;
};

/** Freezes first-birth attribution for checkpoint manifests. Later sync updates
 * can repeat integrated structs, but can never reassign their insertion clocks. */
export function insertionAttributions(
  rows: readonly Pick<
    AttributedJournalRow,
    "admissionSequence" | "batchOrdinal" | "journalRowId" | "originType" | "actorUserId" | "update"
  >[],
  retained: readonly AttributionRunV1[] = [],
): AttributionRunV1[] {
  const index = new RangeIndex<AttributionRunV1>("insertion attribution");
  const result: AttributionRunV1[] = [...retained];
  for (const attribution of retained) {
    index.add(attribution.range, attribution, sameAttribution);
  }
  for (const row of rows) {
    for (const range of journalInsertionRanges(row.update)) {
      const attribution = {
        range,
        birthClass: birthClassFromAttribution(row),
        origin: replayKey(row),
      } satisfies AttributionRunV1;
      for (const uncovered of index.addUncovered(range, attribution)) {
        result.push({ ...attribution, range: uncovered });
      }
    }
  }
  return result;
}

export class ProvenanceMaterializationError extends Error {
  readonly name = "ProvenanceMaterializationError";
}

export function birthClassFromAttribution(
  attribution: Pick<AttributedJournalRow, "originType" | "actorUserId">,
): SafetyBirthClass {
  if (attribution.originType === "human" && attribution.actorUserId) return "writer_protected";
  return "agent";
}

/**
 * Every struct but `Y.Skip` is a clock range its client inserted. A `GC` is one that was
 * inserted and later collected (a gc-on writer's update carries them), so it stays; only a
 * `Skip` is a hole in a merged update. Same rule as `document-containment.ts`.
 */
export function journalInsertionRanges(update: Uint8Array): LineageRange[] {
  return Y.decodeUpdate(update)
    .structs.filter((struct): struct is Y.Item | Y.GC => !(struct instanceof Y.Skip))
    .map((struct) => ({
      clientID: struct.id.client,
      clock: struct.id.clock,
      length: struct.length,
    }));
}

class RangeIndex<T> {
  readonly #byClient = new Map<number, Array<{ range: LineageRange; value: T }>>();
  constructor(private readonly label: string) {}

  add(rangeValue: LineageRange, value: T, same: (left: T, right: T) => boolean): void {
    const range = parseRange(rangeValue);
    const entries = this.#byClient.get(range.clientID) ?? [];
    for (const entry of entries) {
      if (!rangesOverlap(entry.range, range)) continue;
      if (!same(entry.value, value)) throw blocked(`Conflicting append-only ${this.label}`);
    }
    entries.push({ range, value });
    this.#byClient.set(range.clientID, entries);
  }

  /** Journal sync updates may repeat already-integrated structs. Their insertion
   * clocks retain the first row's attribution; only previously unseen gaps are born here. */
  addUncovered(rangeValue: LineageRange, value: T): LineageRange[] {
    const range = parseRange(rangeValue);
    const entries = this.#byClient.get(range.clientID) ?? [];
    const added: LineageRange[] = [];
    let cursor = range.clock;
    const limit = end(range);
    for (const covered of entries
      .map((entry) => entry.range)
      .filter((entry) => rangesOverlap(entry, range))
      .sort((left, right) => left.clock - right.clock)) {
      if (cursor < covered.clock) {
        const gap = { clientID: range.clientID, clock: cursor, length: covered.clock - cursor };
        entries.push({ range: gap, value });
        added.push(gap);
      }
      cursor = Math.max(cursor, end(covered));
      if (cursor >= limit) break;
    }
    if (cursor < limit) {
      const gap = { clientID: range.clientID, clock: cursor, length: limit - cursor };
      entries.push({ range: gap, value });
      added.push(gap);
    }
    this.#byClient.set(range.clientID, entries);
    return added;
  }
}

function parseRange(value: unknown): LineageRange {
  if (!isRecord(value)) throw blocked("Invalid lineage range");
  const { clientID, clock, length } = value;
  if (
    !Number.isSafeInteger(clientID) ||
    !Number.isSafeInteger(clock) ||
    !Number.isSafeInteger(length) ||
    Number(clientID) < 0 ||
    Number(clock) < 0 ||
    Number(length) <= 0 ||
    !Number.isSafeInteger(Number(clock) + Number(length))
  ) {
    throw blocked("Lineage range is outside safe integer bounds");
  }
  return { clientID: Number(clientID), clock: Number(clock), length: Number(length) };
}

function sameAttribution(left: AttributionRunV1, right: AttributionRunV1): boolean {
  return left.birthClass === right.birthClass && compareReplayKey(left.origin, right.origin) === 0;
}
function rangesOverlap(left: LineageRange, right: LineageRange): boolean {
  return left.clientID === right.clientID && left.clock < end(right) && right.clock < end(left);
}
function end(range: LineageRange): number {
  return range.clock + range.length;
}
function replayKey(value: JournalReplayKey): JournalReplayKey {
  return {
    admissionSequence: value.admissionSequence,
    batchOrdinal: value.batchOrdinal,
    journalRowId: value.journalRowId,
  };
}
function compareReplayKey(left: JournalReplayKey, right: JournalReplayKey): number {
  if (left.admissionSequence !== right.admissionSequence) {
    return left.admissionSequence < right.admissionSequence ? -1 : 1;
  }
  return (
    left.batchOrdinal - right.batchOrdinal ||
    (left.journalRowId === right.journalRowId ? 0 : left.journalRowId < right.journalRowId ? -1 : 1)
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function blocked(message: string): ProvenanceMaterializationError {
  return new ProvenanceMaterializationError(message);
}
