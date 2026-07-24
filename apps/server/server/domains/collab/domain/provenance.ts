/** Deterministic safety-provenance facts, replay, and client namespace admission. */

import {
  type SemanticEditIRV1,
  type SemanticProvenanceWriter,
  unwrapBlock,
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

/** Freezes first-birth attribution for checkpoint manifests. Later sync updates
 * can repeat integrated structs, but can never reassign their insertion clocks. */
export function insertionAttributions(
  rows: readonly Pick<
    AttributedJournalRow,
    "admissionSequence" | "batchOrdinal" | "journalRowId" | "originType" | "actorUserId" | "update"
  >[],
): AttributionRunV1[] {
  const index = new RangeIndex<AttributionRunV1>("insertion attribution");
  const result: AttributionRunV1[] = [];
  for (const row of rows) {
    for (const range of insertionRanges(row.update)) {
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

/** Derives the normalized view for an already-materialized durable settlement doc. */
export function materializeProvenanceForDoc(input: {
  doc: Y.Doc;
  rows: readonly AttributedJournalRow[];
  retainedAttributions?: readonly AttributionRunV1[];
  /** Settlement lock cuts may contain writer-ingress roots captured before their
   * attributed replay row; classify that unexplained authority conservatively. */
  fallbackBirthClass?: SafetyBirthClass;
}): ProvenanceRun[] {
  const attributions = new RangeIndex<AttributionRunV1>("insertion attribution");
  for (const attribution of input.retainedAttributions ?? []) {
    attributions.add(attribution.range, attribution, sameAttribution);
  }
  for (const row of input.rows) {
    for (const range of insertionRanges(row.update)) {
      attributions.addUncovered(range, {
        range,
        birthClass: birthClassFromAttribution(row),
        origin: replayKey(row),
      });
    }
  }
  return provenanceRunsForDoc(input.doc, attributions, input.fallbackBirthClass);
}

/** Re-materializes provenance after a candidate update without granting old roots to fresh prose. */
export function materializeCandidateProvenance(
  doc: Y.Doc,
  retained: readonly ProvenanceRun[],
): ProvenanceRun[] {
  const attributions = new RangeIndex<AttributionRunV1>("retained root attribution");
  for (const [index, run] of retained.entries()) {
    attributions.add(
      run.root,
      {
        range: run.root,
        birthClass: run.birthClass,
        origin: { admissionSequence: 0n, batchOrdinal: 0, journalRowId: BigInt(index) },
      },
      sameAttribution,
    );
  }
  return provenanceRunsForDoc(doc, attributions, "agent");
}

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
      attributions.addUncovered(range, {
        range,
        birthClass: birthClassFromAttribution(row),
        origin: replayKey(row),
      });
    }
    Y.applyUpdate(doc, row.update);
  }

  const visible = provenanceRunsForDoc(doc, attributions);
  return { doc, visible, attributionManifest: input.manifest };
}

function provenanceRunsForDoc(
  doc: Y.Doc,
  attributions: RangeIndex<AttributionRunV1>,
  fallbackBirthClass?: SafetyBirthClass,
): ProvenanceRun[] {
  const assignments = readTargetFacts(doc);
  const policies = readRootFacts(doc);
  // Admission validates targets while they are visible. After deletion Yjs may
  // discard the parent ancestry needed to re-prove historical fragment membership,
  // but the immutable target clocks must remain valid for settlement replay.
  const prose = allStringRanges(doc);
  for (const range of visibleProseStringRanges(doc)) prose.add(range, true, () => true);
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
      if (!attribution && !policy && !fallbackBirthClass) {
        throw blocked("Provenance root has no retained attribution or explicit birth policy");
      }
      appendRun(visible, {
        target: targetUnit,
        root: rootUnit,
        birthClass: policy?.birthClass ?? attribution?.birthClass ?? fallbackBirthClass ?? "agent",
      });
    }
  }

  return visible;
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
  assertRootUnitInjectivity(doc, targets);
  doc.transact(() => {
    if (newTargets.length > 0) doc.getArray(PROVENANCE_TARGETS_TYPE).push(newTargets);
    if (newRoots.length > 0) doc.getArray(PROVENANCE_ROOTS_TYPE).push(newRoots);
  }, "meridian-provenance-authority");
  primeReservedNamespaceIndex(doc);
  return Y.encodeStateAsUpdate(doc, before);
}

function assertRootUnitInjectivity(
  doc: Y.Doc,
  assignments: RangeIndex<ProvenanceTargetFactV1>,
): void {
  const occupied = new Map<string, string>();
  for (const target of visibleProseStringRanges(doc)) {
    for (let offset = 0; offset < target.length; offset += 1) {
      const targetUnit = unit(target, offset);
      const assignment = assignments.valueAt(targetUnit);
      const rootUnit = assignment
        ? unit(assignment.root, targetUnit.clock - assignment.target.clock)
        : targetUnit;
      const rootKey = `${rootUnit.clientID}:${rootUnit.clock}`;
      const targetKey = `${targetUnit.clientID}:${targetUnit.clock}`;
      const existing = occupied.get(rootKey);
      if (existing && existing !== targetKey) {
        throw blocked("One provenance root unit cannot have two visible targets");
      }
      occupied.set(rootKey, targetKey);
    }
  }
}

/** Validates every reserved provenance fact against the complete visible prose graph. */
export function validateProvenanceGraph(doc: Y.Doc): void {
  const assignments = readTargetFacts(doc);
  readRootFacts(doc);
  const prose = allStringRanges(doc);
  for (const range of visibleProseStringRanges(doc)) prose.add(range, true, () => true);
  for (const fact of assignments.values()) {
    if (!prose.covers(fact.target)) {
      throw blocked("Explicit provenance target is outside the prosemirror fragment");
    }
  }
  assertRootUnitInjectivity(doc, assignments);
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
  const edits = ir.intent.edits.map(({ edit, outputRuns }) => {
    const runs = [...outputRuns].sort(
      (left, right) => left.output.from - right.output.from || left.output.to - right.output.to,
    );
    return {
      edit,
      runs,
      materializedRuns: runs.filter(
        (run) => run.kind !== "preserved" || run.materialization !== "retained",
      ),
    };
  });
  if (
    !edits.some(({ runs }) =>
      runs.some(({ kind }) => kind === "preserved" || kind === "restoration"),
    )
  ) {
    return;
  }
  const allInserted = insertedStringRanges(Y.encodeStateAsUpdate(doc, beforeStateVector));
  const targets: ProvenanceTargetFactV1[] = [];
  const existingAssignments = readTargetFacts(doc);
  for (const { edit, runs, materializedRuns } of edits) {
    if (!runs.some(({ kind }) => kind === "preserved" || kind === "restoration")) continue;
    const declaredLength = materializedRuns.reduce(
      (sum, run) => sum + run.output.to - run.output.from,
      0,
    );
    const outputLength = runs.at(-1)?.output.to ?? 0;
    const outputWindow = visibleOutputWindow(edit, ir.intent.edits, outputLength);
    const inserted = intersectRangesInOrder(outputWindow, allInserted);
    const insertedLength = inserted.reduce((sum, range) => sum + range.length, 0);
    if (insertedLength !== declaredLength) {
      throw new ProvenanceMaterializationError(
        `Certified semantic output length ${declaredLength} does not match lowered prose insertion length ${insertedLength}`,
      );
    }
    let outputCursor = 0;
    for (const run of materializedRuns) {
      const length = run.output.to - run.output.from;
      const targetRuns = sliceRanges(inserted, outputCursor, length);
      if (run.kind === "preserved" || run.kind === "restoration") {
        const roots =
          run.kind === "preserved"
            ? resolvedRootUnits(existingAssignments, run.source)
            : Array.from({ length }, (_, offset) => unit(run.root, offset));
        const targetUnits = targetRuns.flatMap((target) =>
          Array.from({ length: target.length }, (_, offset) => unit(target, offset)),
        );
        for (let index = 0; index < targetUnits.length; index += 1) {
          const target = targetUnits[index];
          const root = roots[index];
          if (!target || !root)
            throw blocked("Certified continuation length changed during lowering");
          const previous = targets.at(-1);
          if (
            previous &&
            previous.target.clientID === target.clientID &&
            end(previous.target) === target.clock &&
            previous.root.clientID === root.clientID &&
            end(previous.root) === root.clock
          ) {
            previous.target.length += 1;
            previous.root.length += 1;
          } else {
            targets.push({ version: 1, target: { ...target }, root: { ...root } });
          }
        }
      }
      outputCursor += length;
    }
  }
  appendProvenanceFacts(doc, { targets });
}

type MappedEdit = Extract<SemanticEditIRV1["intent"], { kind: "mappedEdits" }>["edits"][number];

function visibleOutputWindow(
  edit: MappedEdit["edit"],
  declarations: readonly MappedEdit[],
  outputLength: number,
): WriterLineageRange[] {
  if (edit.kind === "insert" || edit.kind === "delete") {
    throw new ProvenanceMaterializationError(
      `Certified ${edit.kind} output cannot materialize continuation or restoration facts`,
    );
  }
  const ranges = visibleStringRanges(unwrapBlock(edit.block));
  if (edit.kind === "block") return sliceRanges(ranges, 0, outputLength);
  const start = edit.kind === "text" ? edit.span.start : (edit.replacements[0]?.span.start ?? 0);
  let finalStart = start;
  for (const { edit: other } of declarations) {
    if (other === edit || !("block" in other) || other.block !== edit.block) continue;
    const span = textEditInputSpan(other);
    if (!span) continue;
    if (span.to <= start) {
      finalStart += textEditOutputLength(other) - (span.to - span.from);
    } else if (span.from < start + textEditInputLength(edit) && span.to > start) {
      throw new ProvenanceMaterializationError(
        "Certified text edits overlap while locating provenance output",
      );
    }
  }
  return sliceRanges(ranges, finalStart, outputLength);
}

function textEditInputSpan(edit: MappedEdit["edit"]): { from: number; to: number } | undefined {
  if (edit.kind === "text") return { from: edit.span.start, to: edit.span.end };
  if (edit.kind !== "textRanges") return undefined;
  const first = edit.replacements[0];
  const last = edit.replacements.at(-1);
  return first && last ? { from: first.span.start, to: last.span.end } : undefined;
}

function textEditInputLength(edit: MappedEdit["edit"]): number {
  const span = textEditInputSpan(edit);
  return span ? span.to - span.from : 0;
}

function textEditOutputLength(edit: MappedEdit["edit"]): number {
  if (edit.kind === "text") return edit.newText.length;
  if (edit.kind === "textRanges") return edit.output.length;
  return 0;
}

function resolvedRootUnits(
  assignments: RangeIndex<ProvenanceTargetFactV1>,
  source: WriterLineageRange,
): WriterLineageRange[] {
  return Array.from({ length: source.length }, (_, offset) => {
    const sourceUnit = unit(source, offset);
    const assignment = assignments.valueAt(sourceUnit);
    return assignment
      ? unit(assignment.root, sourceUnit.clock - assignment.target.clock)
      : sourceUnit;
  });
}

function insertedStringRanges(update: Uint8Array): WriterLineageRange[] {
  return (Y.decodeUpdate(update) as DecodedUpdate).structs.flatMap((value) => {
    const struct = asStruct(value);
    return struct.content?.constructor?.name === "ContentString"
      ? [{ clientID: struct.id.client, clock: struct.id.clock, length: struct.length }]
      : [];
  });
}

function intersectRangesInOrder(
  ordered: readonly WriterLineageRange[],
  candidates: readonly WriterLineageRange[],
): WriterLineageRange[] {
  return ordered.flatMap((range) =>
    candidates
      .filter((candidate) => rangesOverlap(range, candidate))
      .map((candidate) => {
        const clock = Math.max(range.clock, candidate.clock);
        return {
          clientID: range.clientID,
          clock,
          length: Math.min(end(range), end(candidate)) - clock,
        };
      })
      .sort((left, right) => left.clock - right.clock),
  );
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

  /** Journal sync updates may repeat already-integrated structs. Their insertion
   * clocks retain the first row's attribution; only previously unseen gaps are born here. */
  addUncovered(rangeValue: WriterLineageRange, value: T): WriterLineageRange[] {
    const range = parseRange(rangeValue);
    const entries = this.#byClient.get(range.clientID) ?? [];
    const added: WriterLineageRange[] = [];
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
  return visibleStringRanges(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
}

function visibleStringRanges(type: Y.XmlElement | Y.XmlText | Y.XmlFragment): WriterLineageRange[] {
  const ranges: WriterLineageRange[] = [];
  const visit = (current: Y.XmlElement | Y.XmlText | Y.XmlFragment): void => {
    if (current instanceof Y.XmlText) {
      let item = (current as unknown as { _start: YItemLike | null })._start;
      while (item) {
        if (!item.deleted && item.content.constructor?.name === "ContentString") {
          ranges.push({ clientID: item.id.client, clock: item.id.clock, length: item.length });
        }
        item = item.right ?? null;
      }
      return;
    }
    for (const child of current.toArray()) {
      if (child instanceof Y.XmlElement || child instanceof Y.XmlText) visit(child);
    }
  };
  visit(type);
  return ranges;
}

function allStringRanges(doc: Y.Doc): RangeIndex<true> {
  const index = new RangeIndex<true>("historical string target");
  const store = (doc as unknown as { store: { clients: Map<number, YItemLike[]> } }).store;
  for (const structs of store.clients.values()) {
    for (const item of structs) {
      if (item.content.constructor?.name !== "ContentString") continue;
      index.add(
        { clientID: item.id.client, clock: item.id.clock, length: item.length },
        true,
        () => true,
      );
    }
  }
  return index;
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
