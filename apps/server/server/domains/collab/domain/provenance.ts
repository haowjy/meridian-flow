/** Deterministic safety-provenance facts, replay, and client namespace admission. */

import {
  type SemanticEditIRV1,
  type SemanticProvenanceWriter,
  unwrapDoc,
  type WriterLineageRange,
} from "@meridian/agent-edit";
import type { DocumentAuthorityId } from "@meridian/contracts";
import { PROSEMIRROR_FRAGMENT_NAME, RESERVED_CLIENT_ID_MAX } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

export const PROVENANCE_TARGETS_TYPE = "__meridian_provenance_targets_v1";
export const PROVENANCE_ROOTS_TYPE = "__meridian_provenance_roots_v1";
export const PROVENANCE_RESERVED_TYPES = [PROVENANCE_TARGETS_TYPE, PROVENANCE_ROOTS_TYPE] as const;
const RESERVED_TYPE_NAMES = new Set<string>(PROVENANCE_RESERVED_TYPES);
const RESERVED_CLIENT_IDS = new Set(
  Array.from({ length: RESERVED_CLIENT_ID_MAX + 1 }, (_, clientId) => clientId),
);
const reservedNamespaceIndexes = new WeakMap<Y.Doc, ReservedRangeIndex>();
let provenanceEnumerationCount = 0;

export type { DocumentAuthorityId } from "@meridian/contracts";
export const INITIAL_DOCUMENT_AUTHORITY_GENERATION = 1n;
export type SafetyBirthClass = "writer_protected" | "agent";

export type ProvenanceTargetFactV1 = {
  version: 1;
  target: WriterLineageRange;
  root: WriterLineageRange;
};

export type ProvenanceRootFactV1 = {
  version: 1;
  root: WriterLineageRange;
  birthClass: SafetyBirthClass;
};

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
  range: WriterLineageRange;
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

export type ProvenanceRun = {
  target: WriterLineageRange;
  root: WriterLineageRange;
  birthClass: SafetyBirthClass;
};

export type ProvenanceMaterialization = {
  doc: Y.Doc;
  visible: ProvenanceRun[];
  attributionManifest: AttributionManifestV1;
};

export class ProvenanceMaterializationError extends Error {
  readonly name = "ProvenanceMaterializationError";
}

/**
 * The sole warm/cold provenance materializer. Attribution is installed before
 * Yjs sees each row, so a pending child keeps the actor that originated it.
 */
export function materializeProvenanceView(input: {
  authorityId: DocumentAuthorityId;
  generation: bigint;
  checkpointUpdate?: Uint8Array;
  manifest: AttributionManifestV1;
  rows: readonly AttributedJournalRow[];
  watermark: JournalReplayKey;
}): ProvenanceMaterialization {
  validateManifestIdentity(input);
  const doc = new Y.Doc({ gc: false });
  const attributions = new RangeIndex<AttributionRunV1>("insertion attribution");
  for (const attribution of input.manifest.attributions) {
    attributions.add(attribution.range, attribution, sameAttribution);
  }
  if (input.checkpointUpdate) Y.applyUpdate(doc, input.checkpointUpdate);

  const rows = [...input.rows].sort(compareReplayKey);
  validateReplayRows(rows, input.manifest.floor, input.watermark, input);
  for (const row of rows) {
    for (const range of insertionRanges(row.update)) {
      attributions.add(
        range,
        { range, birthClass: birthClassFromAttribution(row), origin: replayKey(row) },
        sameAttribution,
      );
    }
    Y.applyUpdate(doc, row.update);
  }

  const assignments = readTargetFacts(doc);
  const policies = readRootFacts(doc);
  const prose = allProseStringRanges(doc);
  for (const fact of assignments.values()) {
    if (!prose.covers(fact.target)) {
      throw blocked("Explicit provenance target is outside the prosemirror fragment");
    }
  }

  const visible: ProvenanceRun[] = [];
  for (const target of visibleProseStringRanges(doc)) {
    for (let offset = 0; offset < target.length; offset += 1) {
      const targetUnit = unit(target, offset);
      const assignment = assignments.valueAt(targetUnit);
      const rootUnit = assignment
        ? unit(assignment.root, targetUnit.clock - assignment.target.clock)
        : targetUnit;
      const attribution = attributions.valueAt(rootUnit);
      const policy = policies.valueAt(rootUnit);
      if (!attribution && !policy) {
        throw blocked("Provenance root has no retained attribution or explicit birth policy");
      }
      appendRun(visible, {
        target: targetUnit,
        root: rootUnit,
        birthClass: policy?.birthClass ?? attribution?.birthClass ?? "agent",
      });
    }
  }

  return { doc, visible, attributionManifest: input.manifest };
}

export function birthClassFromAttribution(
  attribution: Pick<AttributedJournalRow, "originType" | "actorUserId">,
): SafetyBirthClass {
  if (attribution.originType === "human" && attribution.actorUserId) return "writer_protected";
  return "agent";
}

/** Append-only authority writer. Facts are arrays, never last-writer-wins maps. */
export function appendProvenanceFacts(
  doc: Y.Doc,
  input: {
    targets?: readonly ProvenanceTargetFactV1[];
    roots?: readonly ProvenanceRootFactV1[];
  },
): Uint8Array {
  const before = Y.encodeStateVector(doc);
  const targets = readTargetFacts(doc);
  const roots = readRootFacts(doc);
  const newTargets = (input.targets ?? []).map(parseTargetFact);
  const newRoots = (input.roots ?? []).map(parseRootFact);
  for (const fact of newTargets) targets.add(fact.target, fact, sameTargetFact);
  for (const fact of newRoots) roots.add(fact.root, fact, sameRootFact);
  doc.transact(() => {
    if (newTargets.length > 0) doc.getArray(PROVENANCE_TARGETS_TYPE).push(newTargets);
    if (newRoots.length > 0) doc.getArray(PROVENANCE_ROOTS_TYPE).push(newRoots);
  }, "meridian-provenance-authority");
  primeReservedNamespaceIndex(doc);
  return Y.encodeStateAsUpdate(doc, before);
}

export class ReservedNamespaceAdmissionError extends Error {
  readonly name = "ReservedNamespaceAdmissionError";
}

export function createSemanticProvenanceWriter(): SemanticProvenanceWriter {
  return {
    writeCertifiedFacts(docHandle, ir, beforeStateVector) {
      writeCertifiedProvenanceFacts(unwrapDoc(docHandle), ir, beforeStateVector);
    },
  };
}

function writeCertifiedProvenanceFacts(
  doc: Y.Doc,
  ir: SemanticEditIRV1,
  beforeStateVector: Uint8Array,
): void {
  if (ir.intent.kind === "fullScopeFreshReplacement") return;
  const runs = ir.intent.edits.flatMap(({ outputRuns }) => outputRuns);
  if (!runs.some(({ kind }) => kind === "preserved" || kind === "restoration")) return;
  const inserted = insertedStringRanges(Y.encodeStateAsUpdate(doc, beforeStateVector));
  const declaredLength = runs.reduce((sum, run) => sum + run.output.to - run.output.from, 0);
  const insertedLength = inserted.reduce((sum, range) => sum + range.length, 0);
  if (insertedLength !== declaredLength) {
    throw new ProvenanceMaterializationError(
      "Certified semantic output does not match the lowered Yjs insertion ranges",
    );
  }
  const targets: ProvenanceTargetFactV1[] = [];
  let cursor = 0;
  for (const run of runs) {
    const length = run.output.to - run.output.from;
    const targetRuns = sliceRanges(inserted, cursor, length);
    if (run.kind === "preserved" || run.kind === "restoration") {
      let rootOffset = 0;
      const root = run.kind === "preserved" ? run.source : run.root;
      for (const target of targetRuns) {
        targets.push({
          version: 1,
          target,
          root: { clientID: root.clientID, clock: root.clock + rootOffset, length: target.length },
        });
        rootOffset += target.length;
      }
    }
    cursor += length;
  }
  appendProvenanceFacts(doc, { targets });
}

function insertedStringRanges(update: Uint8Array): WriterLineageRange[] {
  return (Y.decodeUpdate(update) as DecodedUpdate).structs.flatMap((value) => {
    const struct = asStruct(value);
    return struct.content?.constructor?.name === "ContentString"
      ? [{ clientID: struct.id.client, clock: struct.id.clock, length: struct.length }]
      : [];
  });
}

function sliceRanges(
  ranges: readonly WriterLineageRange[],
  from: number,
  length: number,
): WriterLineageRange[] {
  const result: WriterLineageRange[] = [];
  let offset = 0;
  const to = from + length;
  for (const range of ranges) {
    const overlapFrom = Math.max(from, offset);
    const overlapTo = Math.min(to, offset + range.length);
    if (overlapFrom < overlapTo) {
      result.push({
        clientID: range.clientID,
        clock: range.clock + overlapFrom - offset,
        length: overlapTo - overlapFrom,
      });
    }
    offset += range.length;
    if (offset >= to) break;
  }
  return result;
}

/** Refresh outside writer admission, immediately after load or authority writes. */
export function primeReservedNamespaceIndex(doc: Y.Doc): void {
  provenanceEnumerationCount += 1;
  reservedNamespaceIndexes.set(doc, reservedStructRanges(doc));
}

export function provenanceInstrumentation(): { enumerations: number } {
  return { enumerations: provenanceEnumerationCount };
}

export function resetProvenanceInstrumentation(): void {
  provenanceEnumerationCount = 0;
}

/**
 * Rejects client structs that enter the reserved ancestry and delete sets that
 * touch authoritative reserved structs. It inspects decoded ranges and the two
 * reserved subtrees only; it never scratch-applies or scans prose.
 */
export function assertClientUpdateOutsideReservedNamespace(
  authoritativeDoc: Y.Doc,
  update: Uint8Array,
): void {
  const decoded = Y.decodeUpdate(update) as DecodedUpdate;
  assertDecodedUpdateOutsideReservedNamespace(
    authoritativeDoc,
    decoded,
    decoded.structs.map(asStruct),
  );
}

export function validateClientUpdateAdmission(
  authoritativeDoc: Y.Doc,
  update: Uint8Array,
): { reservedClientId: number | null } {
  const decoded = Y.decodeUpdate(update) as DecodedUpdate;
  const incoming = decoded.structs.map(asStruct);
  const reservedClientId =
    incoming.find((struct) => RESERVED_CLIENT_IDS.has(struct.id.client))?.id.client ?? null;
  if (reservedClientId === null) {
    assertDecodedUpdateOutsideReservedNamespace(authoritativeDoc, decoded, incoming);
  }
  return { reservedClientId };
}

function assertDecodedUpdateOutsideReservedNamespace(
  authoritativeDoc: Y.Doc,
  decoded: DecodedUpdate,
  incoming: readonly DecodedStruct[],
): void {
  let reserved = reservedNamespaceIndexes.get(authoritativeDoc);
  if (!reserved) {
    provenanceEnumerationCount += 1;
    reserved = reservedStructRanges(authoritativeDoc);
    reservedNamespaceIndexes.set(authoritativeDoc, reserved);
  }
  if (isPlainProseFastPath(incoming, decoded.ds.clients, reserved)) return;
  const incomingByClient = groupStructs(incoming);
  const ancestryMemo = new Map<DecodedStruct, boolean>();

  const hasReservedAncestor = (
    struct: DecodedStruct,
    visiting = new Set<DecodedStruct>(),
  ): boolean => {
    const memo = ancestryMemo.get(struct);
    if (memo !== undefined) return memo;
    if (visiting.has(struct)) throw new ReservedNamespaceAdmissionError("Cyclic Yjs parent chain");
    visiting.add(struct);
    const parent = struct.parent;
    let result = typeof parent === "string" && isReservedName(parent);
    if (!result && isId(parent)) {
      const incomingParent = findStruct(incomingByClient, parent);
      result = incomingParent
        ? hasReservedAncestor(incomingParent, visiting)
        : reserved.contains(parent);
    }
    if (!result) {
      for (const anchor of [struct.origin, struct.rightOrigin]) {
        if (!isId(anchor)) continue;
        const incomingAnchor = findStruct(incomingByClient, anchor);
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
      if (reserved.overlaps({ clientID: client, clock: range.clock, length: range.len })) {
        throw new ReservedNamespaceAdmissionError(
          "Client update deletes reserved provenance state",
        );
      }
    }
  }
}

function isPlainProseFastPath(
  incoming: readonly DecodedStruct[],
  deletes: ReadonlyMap<number, readonly { clock: number; len: number }[]>,
  reserved: ReservedRangeIndex,
): boolean {
  for (const [client, ranges] of deletes) {
    for (const range of ranges) {
      if (reserved.overlaps({ clientID: client, clock: range.clock, length: range.len }))
        return false;
    }
  }
  for (const struct of incoming) {
    if (typeof struct.parent === "string") {
      if (struct.parent !== PROSEMIRROR_FRAGMENT_NAME) return false;
    } else if (!isId(struct.parent) || incomingContains(incoming, struct.parent)) {
      return false;
    } else if (reserved.contains(struct.parent)) {
      return false;
    }
    for (const anchor of [struct.origin, struct.rightOrigin]) {
      if (isId(anchor) && (incomingContains(incoming, anchor) || reserved.contains(anchor))) {
        return false;
      }
    }
  }
  return true;
}

function incomingContains(
  incoming: readonly DecodedStruct[],
  id: { client: number; clock: number },
): boolean {
  return incoming.some(
    (struct) =>
      struct.id.client === id.client &&
      id.clock >= struct.id.clock &&
      id.clock < struct.id.clock + struct.length,
  );
}

function validateManifestIdentity(input: {
  authorityId: DocumentAuthorityId;
  generation: bigint;
  manifest: AttributionManifestV1;
}): void {
  const { manifest } = input;
  if (
    manifest.version !== 1 ||
    manifest.authorityId !== input.authorityId ||
    manifest.generation !== input.generation ||
    manifest.checkpointId.length === 0
  ) {
    throw blocked("Attribution manifest does not name the requested authority generation");
  }
}

function validateReplayRows(
  rows: readonly AttributedJournalRow[],
  floor: JournalReplayKey | null,
  watermark: JournalReplayKey,
  authority: { authorityId: DocumentAuthorityId; generation: bigint },
): void {
  let previous = floor;
  const rowIds = new Set<bigint>();
  for (const row of rows) {
    if (row.authorityId !== authority.authorityId || row.generation !== authority.generation) {
      throw blocked("Journal row belongs to another authority generation");
    }
    if (compareReplayKey(row, watermark) > 0) throw blocked("Journal replay crossed its watermark");
    if (rowIds.has(row.journalRowId)) throw blocked("Journal row has duplicate sequence ownership");
    rowIds.add(row.journalRowId);
    if (previous) {
      const sameAdmission = row.admissionSequence === previous.admissionSequence;
      const nextAdmission = row.admissionSequence === previous.admissionSequence + 1n;
      if (
        (sameAdmission && row.batchOrdinal !== previous.batchOrdinal + 1) ||
        (nextAdmission && row.batchOrdinal !== 0) ||
        (!sameAdmission && !nextAdmission)
      ) {
        throw blocked("Journal replay is missing a row or has duplicate sequence ownership");
      }
    } else if (row.admissionSequence !== 1n || row.batchOrdinal !== 0) {
      throw blocked("Journal replay is missing a row before its retained floor");
    }
    previous = row;
  }
  if (!previous || compareReplayKey(previous, watermark) !== 0) {
    throw blocked("Journal replay does not reach the requested watermark");
  }
}

function insertionRanges(update: Uint8Array): WriterLineageRange[] {
  return (Y.decodeUpdate(update) as DecodedUpdate).structs.map((value) => {
    const struct = asStruct(value);
    return { clientID: struct.id.client, clock: struct.id.clock, length: struct.length };
  });
}

function readTargetFacts(doc: Y.Doc): RangeIndex<ProvenanceTargetFactV1> {
  const index = new RangeIndex<ProvenanceTargetFactV1>("target assignment");
  for (const value of doc.getArray(PROVENANCE_TARGETS_TYPE).toArray()) {
    const fact = parseTargetFact(value);
    index.add(fact.target, fact, sameTargetFact);
  }
  return index;
}

function readRootFacts(doc: Y.Doc): RangeIndex<ProvenanceRootFactV1> {
  const index = new RangeIndex<ProvenanceRootFactV1>("root birth policy");
  for (const value of doc.getArray(PROVENANCE_ROOTS_TYPE).toArray()) {
    const fact = parseRootFact(value);
    index.add(fact.root, fact, sameRootFact);
  }
  return index;
}

class RangeIndex<T> {
  readonly #byClient = new Map<number, Array<{ range: WriterLineageRange; value: T }>>();
  constructor(private readonly label: string) {}

  add(rangeValue: WriterLineageRange, value: T, same: (left: T, right: T) => boolean): void {
    const range = parseRange(rangeValue);
    const entries = this.#byClient.get(range.clientID) ?? [];
    for (const entry of entries) {
      if (!rangesOverlap(entry.range, range)) continue;
      if (!same(entry.value, value)) throw blocked(`Conflicting append-only ${this.label}`);
    }
    entries.push({ range, value });
    this.#byClient.set(range.clientID, entries);
  }

  valueAt(point: { clientID: number; clock: number }): T | undefined {
    return this.#byClient
      .get(point.clientID)
      ?.find(({ range }) => point.clock >= range.clock && point.clock < end(range))?.value;
  }

  covers(range: WriterLineageRange): boolean {
    for (let clock = range.clock; clock < end(range); clock += 1) {
      if (!this.valueAt({ clientID: range.clientID, clock })) return false;
    }
    return true;
  }

  *values(): Iterable<T> {
    for (const entries of this.#byClient.values()) {
      for (const entry of entries) yield entry.value;
    }
  }
}

type YItemLike = {
  id: { client: number; clock: number };
  length: number;
  deleted: boolean;
  parent: unknown;
  content: { constructor?: { name?: string } };
  right?: YItemLike | null;
};

function visibleProseStringRanges(doc: Y.Doc): WriterLineageRange[] {
  const ranges: WriterLineageRange[] = [];
  const visit = (type: Y.XmlElement | Y.XmlText | Y.XmlFragment): void => {
    if (type instanceof Y.XmlText) {
      let item = (type as unknown as { _start: YItemLike | null })._start;
      while (item) {
        if (!item.deleted && item.content.constructor?.name === "ContentString") {
          ranges.push({ clientID: item.id.client, clock: item.id.clock, length: item.length });
        }
        item = item.right ?? null;
      }
      return;
    }
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) visit(child);
    }
  };
  visit(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  return ranges;
}

function allProseStringRanges(doc: Y.Doc): RangeIndex<true> {
  const index = new RangeIndex<true>("prose target");
  const store = (doc as unknown as { store: { clients: Map<number, YItemLike[]> } }).store;
  for (const structs of store.clients.values()) {
    for (const item of structs) {
      if (item.content.constructor?.name === "ContentString" && belongsToProse(item)) {
        index.add(
          { clientID: item.id.client, clock: item.id.clock, length: item.length },
          true,
          () => true,
        );
      }
    }
  }
  return index;
}

function belongsToProse(item: YItemLike): boolean {
  let parent = item.parent;
  const seen = new Set<unknown>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    if (parent instanceof Y.XmlFragment) {
      return [...(parent.doc?.share.entries() ?? [])].some(
        ([name, value]) => name === PROSEMIRROR_FRAGMENT_NAME && value === parent,
      );
    }
    parent = (parent as { _item?: { parent?: unknown } })._item?.parent;
  }
  return false;
}

type DecodedStruct = {
  id: { client: number; clock: number };
  length: number;
  parent: unknown;
  origin?: unknown;
  rightOrigin?: unknown;
  content?: { constructor?: { name?: string } };
};
type DecodedUpdate = {
  structs: unknown[];
  ds: { clients: Map<number, Array<{ clock: number; len: number }>> };
};

function reservedStructRanges(doc: Y.Doc): ReservedRangeIndex {
  const index = new ReservedRangeIndex();
  for (const name of PROVENANCE_RESERVED_TYPES) {
    const type = doc.share.get(name);
    if (type) collectTypeStructs(type, index);
  }
  return index;
}

function collectTypeStructs(type: unknown, index: ReservedRangeIndex): void {
  let item = (type as { _start?: YItemLike | null })._start ?? null;
  while (item) {
    index.add({ clientID: item.id.client, clock: item.id.clock, length: item.length });
    const content = (item as unknown as { content?: { getContent?: () => unknown[] } }).content;
    for (const child of content?.getContent?.() ?? []) collectTypeStructs(child, index);
    item = item.right ?? null;
  }
}

class ReservedRangeIndex {
  readonly byClient = new Map<number, WriterLineageRange[]>();
  add(range: WriterLineageRange): void {
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
  overlaps(range: WriterLineageRange): boolean {
    return this.byClient.get(range.clientID)?.some((value) => rangesOverlap(value, range)) ?? false;
  }
}

function parseTargetFact(value: unknown): ProvenanceTargetFactV1 {
  if (!isRecord(value) || value.version !== 1) throw blocked("Invalid target assignment fact");
  const target = parseRange(value.target);
  const root = parseRange(value.root);
  if (target.length !== root.length) throw blocked("Target assignment must preserve root length");
  return { version: 1, target, root };
}

function parseRootFact(value: unknown): ProvenanceRootFactV1 {
  if (!isRecord(value) || value.version !== 1) throw blocked("Invalid root policy fact");
  if (value.birthClass !== "writer_protected" && value.birthClass !== "agent") {
    throw blocked("Invalid binary root birth policy");
  }
  return { version: 1, root: parseRange(value.root), birthClass: value.birthClass };
}

function parseRange(value: unknown): WriterLineageRange {
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

function appendRun(target: ProvenanceRun[], unitRun: ProvenanceRun): void {
  const previous = target.at(-1);
  if (
    previous &&
    previous.birthClass === unitRun.birthClass &&
    previous.target.clientID === unitRun.target.clientID &&
    end(previous.target) === unitRun.target.clock &&
    previous.root.clientID === unitRun.root.clientID &&
    end(previous.root) === unitRun.root.clock
  ) {
    previous.target.length += 1;
    previous.root.length += 1;
    return;
  }
  target.push({
    target: { ...unitRun.target },
    root: { ...unitRun.root },
    birthClass: unitRun.birthClass,
  });
}

function groupStructs(structs: readonly DecodedStruct[]): Map<number, DecodedStruct[]> {
  const result = new Map<number, DecodedStruct[]>();
  for (const struct of structs) {
    const values = result.get(struct.id.client) ?? [];
    values.push(struct);
    result.set(struct.id.client, values);
  }
  return result;
}

function findStruct(
  structs: ReadonlyMap<number, readonly DecodedStruct[]>,
  id: { client: number; clock: number },
): DecodedStruct | undefined {
  return structs
    .get(id.client)
    ?.find((struct) => id.clock >= struct.id.clock && id.clock < struct.id.clock + struct.length);
}

function asStruct(value: unknown): DecodedStruct {
  const struct = value as DecodedStruct;
  if (!isId(struct.id) || !Number.isSafeInteger(struct.length) || struct.length <= 0) {
    throw new ReservedNamespaceAdmissionError("Malformed Yjs update struct");
  }
  return struct;
}

function sameAttribution(left: AttributionRunV1, right: AttributionRunV1): boolean {
  return left.birthClass === right.birthClass && compareReplayKey(left.origin, right.origin) === 0;
}
function sameTargetFact(left: ProvenanceTargetFactV1, right: ProvenanceTargetFactV1): boolean {
  return sameRange(left.target, right.target) && sameRange(left.root, right.root);
}
function sameRootFact(left: ProvenanceRootFactV1, right: ProvenanceRootFactV1): boolean {
  return sameRange(left.root, right.root) && left.birthClass === right.birthClass;
}
function sameRange(left: WriterLineageRange, right: WriterLineageRange): boolean {
  return (
    left.clientID === right.clientID && left.clock === right.clock && left.length === right.length
  );
}
function rangesOverlap(left: WriterLineageRange, right: WriterLineageRange): boolean {
  return left.clientID === right.clientID && left.clock < end(right) && right.clock < end(left);
}
function unit(range: WriterLineageRange, offset = 0): WriterLineageRange {
  return { clientID: range.clientID, clock: range.clock + offset, length: 1 };
}
function end(range: WriterLineageRange): number {
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
