/**
 * Decoration builder — turns the resolved hunk model into a ProseMirror
 * `DecorationSet` scoped to the current draft-doc positions.
 *
 * All position resolution routes through `Y.RelativePosition` → absolute
 * position via `y-prosemirror`'s binding mapping, so decorations survive
 * remote sync and are never coupled to a specific insert index.
 *
 * Decorations only style content that exists in the draft projection. Removed
 * live content belongs in the Changes compare surface; injecting it as widget
 * DOM makes the manuscript read like the old and proposed versions were merged.
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type * as Y from "yjs";
import {
  relativePositionRuntimeFromState,
  resolveRelativePosition,
} from "../../relative-position-runtime";

import type { InlineReviewOperationKind } from "./model";
import {
  hunkKind,
  type InlineReviewModel,
  indexOperations,
  type ResolvedBlockReviewHunk,
  type ResolvedTextReviewHunk,
} from "./model";

/**
 * Everything the builder needs from the editor state to resolve anchors.
 * Injected rather than pulled from state so the builder can be tested
 * with fakes.
 */
export interface DecorationResolver {
  doc: PMNode;
  yDoc: Y.Doc;
  yFragment: Y.XmlFragment;
  /** The ProseMirror↔Yjs node mapping owned by y-prosemirror's binding. */
  mapping: Map<Y.AbstractType<unknown>, PMNode>;
}

const ADDED_CLASS = "meridian-review-added";
const WRITER_CLASS = "meridian-review-writer";
/** Neutral dashed seam for a CRDT merge artifact (spec §6.2) — not an author tint. */
const MERGED_CLASS = "meridian-review-merged";
const CONFLICT_CLASS = "meridian-review-conflict";
const EMPHASIS_CLASS = "meridian-review-emphasized";
/** Modifier on the insert classes when the decoration covers a whole block node. */
const BLOCK_CLASS = "meridian-review-block";
const HUNK_ATTR = "data-review-hunk";
const OPERATION_ATTR = "data-review-operations";

/**
 * Build a fresh `DecorationSet` from the resolved model. When an anchor no
 * longer resolves (the underlying Yjs items were deleted, or the mapping is
 * mid-rebuild), the hunk is silently dropped for this pass — the next model
 * refresh will produce anchors that resolve, or the plugin will just render
 * fewer decorations until then. Never throws.
 */
export function buildDecorations(
  model: InlineReviewModel | null,
  activeOperationId: string | null,
  resolver: DecorationResolver,
): DecorationSet {
  if (!model || model.hunks.length === 0) return DecorationSet.empty;

  const operationsById = indexOperations(model.operations);
  const decorations: Decoration[] = [];

  for (const hunk of model.hunks) {
    const focused = activeOperationId ? hunk.operationIds.includes(activeOperationId) : false;

    const startPos = resolveAnchor(hunk.relStart, resolver);
    if (startPos == null) continue;

    if (hunk.kind === "block") {
      decorations.push(...blockHunkDecorations(hunk, focused, startPos, operationsById, resolver));
      continue;
    }

    // Insertion range — one decoration per span so nested authorship (a
    // writer edit inside an AI insertion) paints in each owner's color.
    // Fall back to whole-hunk coloring when spans are missing (legacy
    // payloads, or when every span anchor failed to decode).
    if (hunk.relEnd !== hunk.relStart) {
      const endPos = resolveAnchor(hunk.relEnd, resolver);
      if (endPos != null && endPos > startPos && hunk.mergeArtifact) {
        // A merge artifact is neutral, not authored: paint the whole combined
        // range with the merged seam and skip the hued per-span split.
        decorations.push(
          Decoration.inline(
            startPos,
            endPos,
            {
              class: classNames(
                MERGED_CLASS,
                focused && EMPHASIS_CLASS,
                hunk.concurrentConflict && CONFLICT_CLASS,
              ),
              [HUNK_ATTR]: hunk.hunkId,
              [OPERATION_ATTR]: hunk.operationIds.join(" "),
            },
            {
              [HUNK_ATTR]: hunk.hunkId,
              [OPERATION_ATTR]: hunk.operationIds.join(" "),
            },
          ),
        );
      } else if (endPos != null && endPos > startPos) {
        const spanRanges = resolveSpanRanges(hunk, resolver);
        if (spanRanges.length > 0) {
          for (const span of spanRanges) {
            const spanOp = operationsById.get(span.operationId);
            const kind: InlineReviewOperationKind = spanOp?.kind === "writer" ? "writer" : "agent";
            const spanFocused =
              focused || (activeOperationId != null && activeOperationId === span.operationId);
            decorations.push(
              Decoration.inline(
                span.from,
                span.to,
                {
                  class: insertionClassName(kind, spanFocused, hunk.concurrentConflict),
                  [HUNK_ATTR]: hunk.hunkId,
                  [OPERATION_ATTR]: span.operationId,
                },
                {
                  [HUNK_ATTR]: hunk.hunkId,
                  [OPERATION_ATTR]: span.operationId,
                },
              ),
            );
          }
        } else {
          const kind = hunkKind(hunk, operationsById);
          decorations.push(
            Decoration.inline(
              startPos,
              endPos,
              {
                class: insertionClassName(kind, focused, hunk.concurrentConflict),
                [HUNK_ATTR]: hunk.hunkId,
                [OPERATION_ATTR]: hunk.operationIds.join(" "),
              },
              {
                [HUNK_ATTR]: hunk.hunkId,
                [OPERATION_ATTR]: hunk.operationIds.join(" "),
              },
            ),
          );
        }
      }
    }
  }

  return DecorationSet.create(resolver.doc, decorations);
}

/**
 * Decorations for a whole-block replace hunk. The inserted draft block gets a
 * `Decoration.node` (the anchor spans exactly that node), painting the same
 * insert tint family as text hunks at node granularity. Deleted live blocks
 * are intentionally absent here so the editor remains the exact draft
 * projection; their before/after comparison lives in the Changes surface.
 */
function blockHunkDecorations(
  hunk: ResolvedBlockReviewHunk,
  focused: boolean,
  startPos: number,
  operationsById: ReadonlyMap<string, import("@meridian/contracts/drafts").ReviewOperation>,
  resolver: DecorationResolver,
): Decoration[] {
  const decorations: Decoration[] = [];
  const dataAttrs = {
    [HUNK_ATTR]: hunk.hunkId,
    [OPERATION_ATTR]: hunk.operationIds.join(" "),
  };

  if (hunk.insertedBlock) {
    const endPos = resolveAnchor(hunk.relEnd, resolver);
    if (endPos != null && endPos > startPos) {
      const kind = hunkKind(hunk, operationsById);
      const attrs = {
        class: `${insertionClassName(kind, focused, hunk.concurrentConflict)} ${BLOCK_CLASS}`,
        ...dataAttrs,
      };
      const node = resolver.doc.nodeAt(startPos);
      // The server anchors block hunks from before to after one top-level
      // node, so an exact node match is the expected case. Fall back to an
      // inline decoration over the same range when the doc shifted under us
      // (mid-sync) — a tinted range beats an invisible hunk.
      if (node != null && startPos + node.nodeSize === endPos) {
        decorations.push(Decoration.node(startPos, endPos, attrs, dataAttrs));
      } else {
        decorations.push(Decoration.inline(startPos, endPos, attrs, dataAttrs));
      }
    }
  }
  return decorations;
}

interface ResolvedSpanRange {
  operationId: string;
  from: number;
  to: number;
}

/**
 * Resolve a hunk's per-operation spans into absolute-position ranges. Spans
 * whose anchors don't resolve (stale after edits) are dropped; the caller
 * degrades to whole-hunk coloring when none survive. Adjacent or overlapping
 * spans that belong to the same operation are merged so the DOM shows one
 * continuous highlight — never scrabble tiles at a keystroke boundary.
 * Author boundaries (writer↔agent) are preserved because they have
 * different operationIds.
 */
function resolveSpanRanges(
  hunk: ResolvedTextReviewHunk,
  resolver: DecorationResolver,
): ResolvedSpanRange[] {
  const raw: ResolvedSpanRange[] = [];
  for (const span of hunk.spans) {
    const from = resolveAnchor(span.from, resolver);
    const to = resolveAnchor(span.to, resolver);
    if (from == null || to == null || to <= from) continue;
    raw.push({ operationId: span.operationId, from, to });
  }
  if (raw.length <= 1) return raw;
  raw.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: ResolvedSpanRange[] = [];
  for (const range of raw) {
    const last = merged[merged.length - 1];
    if (last && last.operationId === range.operationId && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Pull the resolver context out of an EditorState. Returns `null` if the
 * y-sync plugin hasn't finished binding yet (mapping is empty on the first
 * frame after mount), which the plugin treats as "no decorations this tick."
 */
export function resolverFromState(state: {
  doc: PMNode;
  plugins?: unknown;
  // biome-ignore lint/suspicious/noExplicitAny: EditorState.field is typed via generics we can't parameterise here without pulling prosemirror-state.
  [key: string]: any;
}): DecorationResolver | null {
  const runtime = relativePositionRuntimeFromState(state as never);
  if (!runtime) return null;
  return {
    doc: runtime.doc,
    yDoc: runtime.yDoc,
    yFragment: runtime.yFragment,
    mapping: runtime.mapping,
  };
}

function resolveAnchor(anchor: Y.RelativePosition, resolver: DecorationResolver): number | null {
  return resolveRelativePosition(resolver, anchor);
}

function insertionClassName(
  kind: InlineReviewOperationKind,
  focused: boolean,
  conflict = false,
): string {
  const base = kind === "writer" ? WRITER_CLASS : ADDED_CLASS;
  return classNames(base, focused && EMPHASIS_CLASS, conflict && CONFLICT_CLASS);
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/** Class name constants exported for tests + optional consumer selectors. */
export const inlineReviewClassNames = {
  added: ADDED_CLASS,
  writer: WRITER_CLASS,
  merged: MERGED_CLASS,
  emphasized: EMPHASIS_CLASS,
  block: BLOCK_CLASS,
  conflict: CONFLICT_CLASS,
} as const;
