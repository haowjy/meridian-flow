/** Draft-only authorship boundaries, independent of whether review marks are shown. */
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type * as Y from "yjs";
import { isRemoteDocumentRebuild } from "../../anchors";
import {
  relativePositionForIndex,
  relativePositionRuntimeFromState,
  resolveRelativePosition,
} from "../../relative-position-runtime";
import { rotateWriterClient } from "../../writer-client";
import type { InlineReviewModel } from "./model";

type Range = { from: number; to: number };
type Boundary = Range & { operations: Set<string> };

/** One owner per editor; no timer and no allocation for selection-only transactions. */
export function reviewWriterClient(document: Y.Doc, adoptDocumentClient?: () => void) {
  let previous: Boundary | null = null;
  let anchors: { from: Y.RelativePosition; to: Y.RelativePosition } | null = null;
  const apply = (
    tr: Transaction,
    state: EditorState,
    model: InlineReviewModel | null,
    newState: EditorState,
  ): void => {
    if (isRemoteDocumentRebuild(tr)) {
      // Remote sync replaces the PM document wholesale; mapping that replacement
      // would inflate a local typing range to the entire chapter. Use identity.
      const runtime = relativePositionRuntimeFromState(newState);
      const from = runtime && anchors && resolveRelativePosition(runtime, anchors.from);
      const to = runtime && anchors && resolveRelativePosition(runtime, anchors.to);
      if (previous) previous = { ...previous, from: from ?? -1, to: to ?? -1 };
      return;
    }
    if (!tr.docChanged) return;
    const ranges: Range[] = [];
    tr.mapping.maps.forEach((map, index) => {
      // Each step addresses its own intermediate document. Classify in the
      // original document, before y-prosemirror has written this transaction.
      const back = tr.mapping.slice(0, index).invert();
      map.forEach((from, to) => {
        ranges.push({ from: back.map(from, -1), to: back.map(to, 1) });
      });
    });
    if (ranges.length === 0) ranges.push({ from: tr.selection.from, to: tr.selection.to });
    const from = Math.min(...ranges.map((range) => range.from));
    const to = Math.max(...ranges.map((range) => range.to));
    const operations = new Set<string>();
    const runtime = relativePositionRuntimeFromState(state);
    if (model && runtime) {
      const classes = new Set<string>();
      for (const hunk of model.hunks) {
        const start = resolveRelativePosition(runtime, hunk.relStart);
        const end = resolveRelativePosition(runtime, hunk.relEnd);
        if (
          start == null ||
          end == null ||
          !ranges.some((range) => range.from <= end && range.to >= start)
        )
          continue;
        for (const id of hunk.operationIds) {
          const operation = model.operations.find((candidate) => candidate.operationId === id);
          if (operation) classes.add(operation.closureClassId);
        }
      }
      for (const operation of model.operations) {
        if (classes.has(operation.closureClassId)) operations.add(operation.operationId);
      }
    }
    const sameChange =
      previous &&
      ([...operations].some((id) => previous?.operations.has(id)) ||
        (from <= previous.to && to >= previous.from));
    if (previous && !sameChange) {
      // The presence owner migrates the awareness identity too: upstream
      // Hocuspocus and cursor plugins compare it with document.clientID.
      // Never reuse an integrated client, including the previous local one.
      rotateWriterClient(document, adoptDocumentClient);
    }
    const boundary = { from, to, operations };
    if (sameChange && previous && from <= previous.to && to >= previous.from) {
      boundary.from = Math.min(from, previous.from);
      boundary.to = Math.max(to, previous.to);
      for (const id of previous.operations) operations.add(id);
    }
    previous = mapBoundary(boundary, tr);
  };
  return {
    apply,
    capture(state: EditorState) {
      const runtime = relativePositionRuntimeFromState(state);
      const from = runtime && previous && relativePositionForIndex(runtime, previous.from);
      const to = runtime && previous && relativePositionForIndex(runtime, previous.to);
      anchors = from && to ? { from, to } : null;
    },
  };
}

function mapBoundary(boundary: Boundary, tr: Transaction): Boundary {
  return {
    ...boundary,
    from: tr.mapping.map(boundary.from, -1),
    to: tr.mapping.map(boundary.to, 1),
  };
}
