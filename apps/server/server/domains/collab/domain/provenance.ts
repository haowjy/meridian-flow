/** Deterministic safety-provenance facts, replay, and client namespace admission. */

import { APPLY_RECORD_ROOT, RESTORED_ROOT, REVIEW_BASE_FRAGMENT } from "@meridian/agent-edit/diff";
import type { LineageRange } from "@meridian/agent-edit/integration";
import { indexDecodedStructs } from "@meridian/agent-edit/yjs-mutation";
import type { DocumentAuthorityId } from "@meridian/contracts";
import { PROSEMIRROR_FRAGMENT_NAME, RESERVED_CLIENT_ID_MAX } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export const SERVER_OWNED_ROOTS = [REVIEW_BASE_FRAGMENT, APPLY_RECORD_ROOT] as const;
const RESERVED_TYPE_NAMES = new Set<string>(SERVER_OWNED_ROOTS);
const RESERVED_CLIENT_IDS = new Set(
  Array.from({ length: RESERVED_CLIENT_ID_MAX + 1 }, (_, clientId) => clientId),
);
const reservedNamespaceIndexes = new WeakMap<Y.Doc, ReservedRangeIndex>();
let provenanceEnumerationCount = 0;

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
  generation: bigint;
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
  generation: bigint;
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

export class ReservedNamespaceAdmissionError extends Error {
  readonly name = "ReservedNamespaceAdmissionError";
}

/** Refresh outside writer admission, immediately after load or provenance writes. */
export function primeReservedNamespaceIndex(doc: Y.Doc): void {
  provenanceEnumerationCount += 1;
  cacheReservedNamespaceIndex(doc, reservedStructRanges(doc));
}

export function provenanceInstrumentation(): { enumerations: number } {
  return { enumerations: provenanceEnumerationCount };
}

export function resetProvenanceInstrumentation(): void {
  provenanceEnumerationCount = 0;
}

export function validateClientUpdateAdmission(
  referenceDocument: Y.Doc,
  update: Uint8Array,
): { reservedClientId: number | null } {
  const decoded = decodeAdmittedUpdate(update);
  const incoming = decoded.structs;
  const reservedClientId =
    incoming.find((struct) => RESERVED_CLIENT_IDS.has(struct.id.client))?.id.client ?? null;
  assertDecodedUpdateOutsideReservedNamespace(referenceDocument, decoded, incoming);
  return { reservedClientId };
}

function assertDecodedUpdateOutsideReservedNamespace(
  referenceDocument: Y.Doc,
  decoded: DecodedUpdate,
  incoming: readonly DecodedStruct[],
): void {
  let reserved = reservedNamespaceIndexes.get(referenceDocument);
  if (!reserved) {
    provenanceEnumerationCount += 1;
    reserved = reservedStructRanges(referenceDocument);
    cacheReservedNamespaceIndex(referenceDocument, reserved);
  }
  // Bulk Discard/Undo frames have tens of thousands of linked structs; ancestry must not
  // scan that array again for every parent and origin, blocking the socket heartbeat.
  const incomingAt = indexDecodedStructs(incoming);
  if (isPlainProseFastPath(incoming, incomingAt, decoded.ds.clients, reserved, referenceDocument))
    return;
  const ancestryMemo = new Map<DecodedStruct, boolean>();

  const hasReservedAncestor = (
    struct: DecodedStruct,
    visiting = new Set<DecodedStruct>(),
  ): boolean => {
    const memo = ancestryMemo.get(struct);
    if (memo !== undefined) return memo;
    if (visiting.has(struct)) throw new ReservedNamespaceAdmissionError("Cyclic Yjs parent chain");
    if (!(struct instanceof Y.Item)) return false;
    visiting.add(struct);
    const parent = decodedParent(struct);
    let result = typeof parent === "string" && isReservedName(parent);
    if (!result && isId(parent)) {
      const incomingParent = incomingAt(parent);
      result = incomingParent
        ? hasReservedAncestor(incomingParent, visiting)
        : reserved.contains(parent);
    }
    if (!result) {
      for (const anchor of [struct.origin, struct.rightOrigin]) {
        if (!isId(anchor)) continue;
        const incomingAnchor = incomingAt(anchor);
        if (
          (incomingAnchor && hasReservedAncestor(incomingAnchor, visiting)) ||
          reserved.contains(anchor)
        ) {
          result = true;
          break;
        }
      }
    }
    visiting.delete(struct);
    ancestryMemo.set(struct, result);
    return result;
  };

  if (incoming.some((struct) => hasReservedAncestor(struct))) {
    throw new ReservedNamespaceAdmissionError("Client update authors reserved provenance state");
  }
  for (const [client, ranges] of decoded.ds.clients) {
    for (const range of ranges) {
      if (
        reserved.deletesLiveState(referenceDocument, {
          clientID: client,
          clock: range.clock,
          length: range.len,
        })
      ) {
        throw new ReservedNamespaceAdmissionError(
          "Client update deletes reserved provenance state",
        );
      }
    }
  }
}

function isPlainProseFastPath(
  incoming: readonly DecodedStruct[],
  incomingAt: (id: Y.ID) => DecodedStruct | undefined,
  deletes: ReadonlyMap<number, readonly { clock: number; len: number }[]>,
  reserved: ReservedRangeIndex,
  referenceDocument: Y.Doc,
): boolean {
  for (const [client, ranges] of deletes) {
    for (const range of ranges) {
      if (
        reserved.deletesLiveState(referenceDocument, {
          clientID: client,
          clock: range.clock,
          length: range.len,
        })
      )
        return false;
    }
  }
  for (const struct of incoming) {
    if (!(struct instanceof Y.Item)) return false;
    const parent = decodedParent(struct);
    if (typeof parent === "string") {
      if (parent !== PROSEMIRROR_FRAGMENT_NAME) return false;
    } else if (!isId(parent) || incomingAt(parent)) {
      return false;
    } else if (reserved.contains(parent)) {
      return false;
    }
    for (const anchor of [struct.origin, struct.rightOrigin]) {
      if (isId(anchor) && (incomingAt(anchor) || reserved.contains(anchor))) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Every struct but `Y.Skip` is a clock range its client inserted. A `GC` is one that was
 * inserted and later collected (a gc-on writer's update carries them), so it stays; only a
 * `Skip` is a hole in a merged update. Same rule as `document-containment.ts`.
 */
export function journalInsertionRanges(update: Uint8Array): LineageRange[] {
  return decodeAdmittedUpdate(update)
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

type DecodedStruct = Y.Item | Y.GC | Y.Skip;
type DecodedUpdate = ReturnType<typeof Y.decodeUpdate>;

const watchedNamespaceDocs = new WeakSet<Y.Doc>();
function cacheReservedNamespaceIndex(doc: Y.Doc, index: ReservedRangeIndex): void {
  reservedNamespaceIndexes.set(doc, index);
  if (watchedNamespaceDocs.has(doc)) return;
  watchedNamespaceDocs.add(doc);
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    for (const name of RESERVED_TYPE_NAMES) {
      const root = doc.share.get(name);
      if (root && transaction.changedParentTypes.has(root)) {
        reservedNamespaceIndexes.delete(doc);
        break;
      }
    }
  });
}

/** Writer restoration records assert known id ranges, not retained tombstone content. */
export function validateRestorationRanges(doc: Y.Doc, update: Uint8Array): void {
  const root = doc.share.get(RESTORED_ROOT);
  if (!root) return;
  const known = (client: number, clock: number, length: number) =>
    client >= 0 &&
    client <= 0xffffffff &&
    clock >= 0 &&
    length > 0 &&
    Number.isSafeInteger(clock + length) &&
    Y.getState(doc.store, client) >= clock + length;
  for (const struct of decodeAdmittedUpdate(update).structs) {
    if (!(struct instanceof Y.Item)) continue;
    const item = Y.getItem(doc.store, struct.id);
    if (!(item instanceof Y.Item) || item.parent !== root) continue;
    if (!(struct.content instanceof Y.ContentAny)) {
      throw new ReservedNamespaceAdmissionError("Invalid restoration record");
    }
    for (const raw of struct.content.getContent()) {
      if (
        !Array.isArray(raw) ||
        !raw.every(Number.isSafeInteger) ||
        ![3, 4, 5].includes(raw.length) ||
        !known(raw[0], raw[1], raw[2]) ||
        (raw.length === 4 && raw[3] !== 0) ||
        (raw.length === 5 &&
          (!known(raw[3], raw[4], raw[2]) ||
            (raw[0] === raw[3] && raw[1] < raw[4] + raw[2] && raw[4] < raw[1] + raw[2])))
      ) {
        throw new ReservedNamespaceAdmissionError(
          "Restoration record names invalid or unknown ranges",
        );
      }
    }
  }
}

function reservedStructRanges(doc: Y.Doc): ReservedRangeIndex {
  const index = new ReservedRangeIndex();
  for (const name of RESERVED_TYPE_NAMES) {
    const type = doc.share.get(name);
    if (type)
      collectTypeStructs(
        type,
        index,
        SERVER_OWNED_ROOTS.some((root) => root === name),
      );
  }
  return index;
}

function collectTypeStructs<E>(
  type: Y.AbstractType<E>,
  index: ReservedRangeIndex,
  serverOwned: boolean,
): void {
  const collect = (item: Y.Item): void => {
    index.add({ clientID: item.id.client, clock: item.id.clock, length: item.length }, serverOwned);
    if (item.content instanceof Y.ContentType)
      collectTypeStructs(item.content.type, index, serverOwned);
  };
  for (const entry of type._map.values()) {
    for (let item: Y.Item | null = entry; item; item = item.left) collect(item);
  }
  for (let item = type._start; item; item = item.right) collect(item);
}

class ReservedRangeIndex {
  readonly byClient = new Map<number, LineageRange[]>();
  readonly serverOwned = new Set<LineageRange>();
  add(range: LineageRange, serverOwned: boolean): void {
    if (serverOwned) this.serverOwned.add(range);
    const ranges = this.byClient.get(range.clientID) ?? [];
    ranges.push(range);
    this.byClient.set(range.clientID, ranges);
  }
  contains(id: { client: number; clock: number }): boolean {
    return (
      this.byClient
        .get(id.client)
        ?.some((range) => id.clock >= range.clock && id.clock < end(range)) ?? false
    );
  }
  deletesLiveState(doc: Y.Doc, range: LineageRange): boolean {
    for (const owned of this.byClient.get(range.clientID) ?? []) {
      if (!rangesOverlap(owned, range)) continue;
      // Preserve live's provenance admission: even repeated provenance deletions are refused.
      if (!this.serverOwned.has(owned)) return true;
      const limit = Math.min(end(owned), end(range));
      for (let clock = Math.max(owned.clock, range.clock); clock < limit; ) {
        const item = Y.getItem(doc.store, Y.createID(range.clientID, clock));
        if (!item.deleted) return true;
        clock = Math.min(item.id.clock + item.length, limit);
      }
    }
    return false;
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

function decodeAdmittedUpdate(update: Uint8Array): DecodedUpdate {
  const decoded = Y.decodeUpdate(update);
  for (const struct of decoded.structs) {
    if (!isId(struct.id) || !Number.isSafeInteger(struct.length) || struct.length <= 0) {
      throw new ReservedNamespaceAdmissionError("Malformed Yjs update struct");
    }
  }
  return decoded;
}

/** A decoded, unintegrated item names a root parent by its share key, which Yjs's
 * typings omit (they describe integrated items); widen before narrowing. */
function decodedParent(item: Y.Item): unknown {
  return item.parent;
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
function isReservedName(value: string): boolean {
  return RESERVED_TYPE_NAMES.has(value);
}
function isId(value: unknown): value is { client: number; clock: number } {
  return isRecord(value) && Number.isSafeInteger(value.client) && Number.isSafeInteger(value.clock);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function blocked(message: string): ProvenanceMaterializationError {
  return new ProvenanceMaterializationError(message);
}
