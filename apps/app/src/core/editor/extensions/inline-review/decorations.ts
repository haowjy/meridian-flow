/**
 * Decoration builder — turns the resolved hunk model into a ProseMirror
 * `DecorationSet` scoped to the current draft-doc positions.
 *
 * All position resolution routes through `Y.RelativePosition` → absolute
 * position via `y-prosemirror`'s binding mapping, so decorations survive
 * remote sync and are never coupled to a specific insert index.
 *
 * Widget rendering (deleted content) is intentionally minimal — a read-only
 * element marked `contenteditable="false"` with a `data-` attribute pair so
 * the sidebar can find and emphasize it: a `<span>` for deleted text inside a
 * text hunk, a full-width `<div>` standing in for a whole deleted block.
 * Widget-DOM stays outside the document's text content: it must not
 * participate in cursor movement, copy, or select-all — those behaviours come
 * from the widget spec's defaults (`side: -1`, no marks, plain HTMLElement).
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { relativePositionToAbsolutePosition, ySyncPluginKey } from "@tiptap/y-tiptap";
import type * as Y from "yjs";

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
const CONFLICT_CHIP_CLASS = "meridian-review-conflict-chip";
const EMPHASIS_CLASS = "meridian-review-emphasized";
const WIDGET_CLASS = "meridian-review-removed";
/** Modifier on the insert classes when the decoration covers a whole block node. */
const BLOCK_CLASS = "meridian-review-block";
/** Modifier on the removed widget when it stands in for a whole deleted block. */
const BLOCK_WIDGET_CLASS = "meridian-review-removed-block";
const HUNK_ATTR = "data-review-hunk";
const OPERATION_ATTR = "data-review-operations";
/** Carries the deleted block's node type so CSS can shape special cases (rules). */
const BLOCK_TYPE_ATTR = "data-review-block-type";

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

    if (hunk.concurrentConflict) {
      decorations.push(
        Decoration.widget(startPos, () => renderConflictChip(hunk.hunkId), {
          side: -2,
          key: `${hunk.hunkId}:concurrent-conflict`,
          ignoreSelection: true,
          [HUNK_ATTR]: hunk.hunkId,
        }),
      );
    }

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

    // Deletion widget — read-only span rendering the removed text.
    if (hunk.deletedText) {
      decorations.push(
        Decoration.widget(startPos, () => renderDeletionWidget(hunk, focused), {
          // Draw before the anchor character so a deletion that lived *at* a
          // paragraph boundary reads on the correct line.
          side: -1,
          // Widget must not be part of the document text stream — key it so
          // ProseMirror re-uses the DOM across mapped transactions instead
          // of destroying and rebuilding it.
          key: `${hunk.hunkId}:${focused ? "focus" : "rest"}`,
          ignoreSelection: true,
          [HUNK_ATTR]: hunk.hunkId,
          [OPERATION_ATTR]: hunk.operationIds.join(" "),
        }),
      );
    }
  }

  return DecorationSet.create(resolver.doc, decorations);
}

/**
 * Decorations for a whole-block replace hunk. The inserted draft block gets a
 * `Decoration.node` (the anchor spans exactly that node), painting the same
 * insert tint family as text hunks at node granularity. The deleted live
 * block — which no longer exists in the draft doc — renders as a full-width
 * widget above the anchor, striking the server's one-line `display`
 * rendering of the old block. A change hunk emits both: struck old block
 * directly above the highlighted new one.
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

  if (hunk.deletedBlock) {
    const deletedBlock = hunk.deletedBlock;
    decorations.push(
      Decoration.widget(startPos, () => renderBlockDeletionWidget(hunk, deletedBlock, focused), {
        // Draw before the anchor so the struck old block sits directly above
        // the inserted replacement (or at the delete site for pure deletes).
        side: -1,
        key: `${hunk.hunkId}:block:${focused ? "focus" : "rest"}`,
        ignoreSelection: true,
        ...dataAttrs,
      }),
    );
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
  const pluginState = ySyncPluginKey.getState(state as never) as
    | {
        doc?: Y.Doc;
        type?: Y.XmlFragment;
        binding?: { mapping: Map<Y.AbstractType<unknown>, PMNode> };
      }
    | undefined;
  if (!pluginState?.doc || !pluginState.type || !pluginState.binding) return null;
  return {
    doc: state.doc,
    yDoc: pluginState.doc,
    yFragment: pluginState.type,
    mapping: pluginState.binding.mapping,
  };
}

function resolveAnchor(anchor: Y.RelativePosition, resolver: DecorationResolver): number | null {
  const pos = relativePositionToAbsolutePosition(
    resolver.yDoc,
    resolver.yFragment,
    anchor,
    resolver.mapping,
  );
  if (pos == null) return null;
  // A resolved anchor past the document size means the referenced item was
  // deleted after the model was computed; skip until the next refresh.
  if (pos < 0 || pos > resolver.doc.content.size) return null;
  return pos;
}

function insertionClassName(
  kind: InlineReviewOperationKind,
  focused: boolean,
  conflict = false,
): string {
  const base = kind === "writer" ? WRITER_CLASS : ADDED_CLASS;
  return classNames(base, focused && EMPHASIS_CLASS, conflict && CONFLICT_CLASS);
}

function renderDeletionWidget(hunk: ResolvedTextReviewHunk, focused: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = classNames(
    WIDGET_CLASS,
    focused && EMPHASIS_CLASS,
    hunk.concurrentConflict && CONFLICT_CLASS,
  );
  span.setAttribute("contenteditable", "false");
  span.setAttribute(HUNK_ATTR, hunk.hunkId);
  span.setAttribute(OPERATION_ATTR, hunk.operationIds.join(" "));
  // Hidden from a11y trees by default — the sidebar surfaces the same content
  // as structured proposals; screen readers should not read strikethrough
  // widgets as inline prose.
  span.setAttribute("aria-hidden", "true");
  span.textContent = hunk.deletedText ?? "";
  return span;
}

/**
 * Full-width stand-in for a deleted block. Reuses the removed visual language
 * (tint + strikethrough) at block shape; the `display` string is the server's
 * one-line rendering of the old block, so even an atom node like a horizontal
 * rule shows a visible struck glyph instead of an empty span.
 */
function renderBlockDeletionWidget(
  hunk: ResolvedBlockReviewHunk,
  deletedBlock: NonNullable<ResolvedBlockReviewHunk["deletedBlock"]>,
  focused: boolean,
): HTMLElement {
  const block = document.createElement("div");
  block.className = classNames(
    WIDGET_CLASS,
    BLOCK_WIDGET_CLASS,
    focused && EMPHASIS_CLASS,
    hunk.concurrentConflict && CONFLICT_CLASS,
  );
  block.setAttribute("contenteditable", "false");
  block.setAttribute(HUNK_ATTR, hunk.hunkId);
  block.setAttribute(OPERATION_ATTR, hunk.operationIds.join(" "));
  block.setAttribute(BLOCK_TYPE_ATTR, deletedBlock.type);
  block.setAttribute("aria-hidden", "true");
  block.textContent = deletedBlock.display;
  return block;
}

function renderConflictChip(hunkId: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = CONFLICT_CHIP_CLASS;
  chip.setAttribute("contenteditable", "false");
  chip.setAttribute(HUNK_ATTR, hunkId);
  chip.textContent = "edited since this draft was written";
  return chip;
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
  removed: WIDGET_CLASS,
  block: BLOCK_CLASS,
  removedBlock: BLOCK_WIDGET_CLASS,
  conflict: CONFLICT_CLASS,
  conflictChip: CONFLICT_CHIP_CLASS,
} as const;
