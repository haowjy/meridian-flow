// Single-Transform ProseMirror lowering and exact continuation propagation.

import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import type { LineageRange } from "./lineage/range-set.js";

export interface PmSourceContinuation {
  /** ProseMirror positions in the input document, half-open. */
  source: { from: number; to: number };
  root: LineageRange;
}

export interface MappedContinuation {
  /** ProseMirror positions in the lowered document, half-open. */
  target: { from: number; to: number };
  root: LineageRange;
}

export interface ProseMirrorLoweringResult {
  document: PMNode;
  transform: Transform;
  continuations: MappedContinuation[];
}

/**
 * Build and execute exactly one PM Transform. Mapping, rather than content equality, is the
 * only source of preservation: normal unchanged positions and ReplaceAroundStep gaps map;
 * replaced/deleted positions do not. Inserted slices therefore never acquire a source root.
 */
export function lowerProseMirrorTransform(input: {
  document: PMNode;
  continuations: readonly PmSourceContinuation[];
  build(transform: Transform): void;
}): ProseMirrorLoweringResult {
  validateSourceContinuations(input.document, input.continuations);
  const transform = new Transform(input.document);
  input.build(transform);
  const continuations = propagateContinuations(transform, input.continuations, {
    source: input.document,
    target: transform.doc,
  });
  return { document: transform.doc, transform, continuations };
}

export function propagateContinuations(
  transform: Pick<Transform, "mapping">,
  declarations: readonly PmSourceContinuation[],
  documents?: { source: PMNode; target: PMNode },
): MappedContinuation[] {
  const units: Array<{ targetFrom: number; targetTo: number; root: LineageRange }> = [];
  for (const declaration of declarations) {
    const sourceLength = declaration.source.to - declaration.source.from;
    if (sourceLength !== declaration.root.length) {
      throw new Error("PM continuation must be length-preserving");
    }
    for (let offset = 0; offset < sourceLength; ) {
      const sourceFrom = declaration.source.from + offset;
      const unitLength = documents && splitsSurrogatePair(documents.source, sourceFrom + 1) ? 2 : 1;
      const sourceTo = sourceFrom + unitLength;
      const mappedFrom = transform.mapping.mapResult(sourceFrom, 1);
      const mappedTo = transform.mapping.mapResult(sourceTo, -1);
      if (
        !mappedFrom.deleted &&
        !mappedTo.deleted &&
        mappedTo.pos - mappedFrom.pos === unitLength &&
        documents &&
        !splitsSurrogatePair(documents.target, mappedFrom.pos) &&
        !splitsSurrogatePair(documents.target, mappedTo.pos)
      ) {
        units.push({
          targetFrom: mappedFrom.pos,
          targetTo: mappedTo.pos,
          root: {
            clientID: declaration.root.clientID,
            clock: declaration.root.clock + offset,
            length: unitLength,
          },
        });
      } else if (
        !documents &&
        !mappedFrom.deleted &&
        !mappedTo.deleted &&
        mappedTo.pos - mappedFrom.pos === unitLength
      ) {
        units.push({
          targetFrom: mappedFrom.pos,
          targetTo: mappedTo.pos,
          root: {
            clientID: declaration.root.clientID,
            clock: declaration.root.clock + offset,
            length: unitLength,
          },
        });
      }
      offset += unitLength;
    }
  }
  units.sort(
    (left, right) =>
      left.targetFrom - right.targetFrom ||
      left.root.clientID - right.root.clientID ||
      left.root.clock - right.root.clock,
  );
  const result: MappedContinuation[] = [];
  for (const unit of units) {
    const previous = result.at(-1);
    if (
      previous &&
      previous.target.to === unit.targetFrom &&
      previous.root.clientID === unit.root.clientID &&
      previous.root.clock + previous.root.length === unit.root.clock
    ) {
      previous.target.to = unit.targetTo;
      previous.root.length += unit.root.length;
    } else {
      result.push({
        target: { from: unit.targetFrom, to: unit.targetTo },
        root: { ...unit.root },
      });
    }
  }
  return result;
}

/** Post-lowering exhaustive/disjoint target validation; never fills gaps as fresh. */
export function validateLoweredTargetPartition(input: {
  visibleTargets: readonly { from: number; to: number }[];
  claimedTargets: readonly { from: number; to: number }[];
}): void {
  const visible = expandPositions(input.visibleTargets);
  const claimed = expandPositions(input.claimedTargets, true);
  if (visible.size !== claimed.size || [...visible].some((position) => !claimed.has(position))) {
    throw new Error("Lowered visible prose contains an omitted, extra, or unclaimed target");
  }
}

function expandPositions(
  ranges: readonly { from: number; to: number }[],
  rejectOverlap = false,
): Set<number> {
  const positions = new Set<number>();
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.from) ||
      !Number.isSafeInteger(range.to) ||
      range.to < range.from
    ) {
      throw new Error("Invalid ProseMirror target range");
    }
    for (let position = range.from; position < range.to; position += 1) {
      if (rejectOverlap && positions.has(position))
        throw new Error("Lowered target claims overlap");
      positions.add(position);
    }
  }
  return positions;
}

function validateSourceContinuations(
  document: PMNode,
  declarations: readonly PmSourceContinuation[],
): void {
  for (const declaration of declarations) {
    if (
      !Number.isSafeInteger(declaration.source.from) ||
      !Number.isSafeInteger(declaration.source.to) ||
      declaration.source.from < 0 ||
      declaration.source.to <= declaration.source.from ||
      declaration.source.to > document.content.size
    ) {
      throw new Error("Invalid PM continuation source span");
    }
    if (declaration.source.to - declaration.source.from !== declaration.root.length) {
      throw new Error("PM continuation must be length-preserving");
    }
    if (
      splitsSurrogatePair(document, declaration.source.from) ||
      splitsSurrogatePair(document, declaration.source.to)
    ) {
      throw new Error("PM continuation splits a UTF-16 surrogate pair");
    }
  }
}

function splitsSurrogatePair(document: PMNode, position: number): boolean {
  if (position <= 0 || position >= document.content.size) return false;
  let split = false;
  document.descendants((node, nodePosition) => {
    if (!node.isText || !node.text) return;
    const offset = position - nodePosition;
    if (offset <= 0 || offset >= node.text.length) return;
    const high = node.text.charCodeAt(offset - 1);
    const low = node.text.charCodeAt(offset);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) split = true;
  });
  return split;
}
