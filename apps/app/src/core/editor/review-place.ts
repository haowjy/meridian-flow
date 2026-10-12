/**
 * The writer's place in a review editor (first visible block, caret, focus),
 * carried across the editor's replacement by the next draft generation or by
 * the live editor taking over. Held in memory only: it is never a reading
 * position and never reaches dock persistence.
 *
 * Capture runs just before the old editor leaves the screen, so it holds the
 * latest place, not the place at some earlier click. Restore runs once the
 * successor is synced, carries the writer's unsent edits, shows its review
 * projection and has layout, in the task that releases the paint cover. It
 * restores the selection without scrolling it into view, then the viewport
 * from the block anchor, then focus without scrolling.
 */
import type { Editor } from "@tiptap/core";
import { Selection, TextSelection } from "@tiptap/pm/state";
import * as Y from "yjs";
import { getInlineReviewPluginState, operationKey } from "./extensions/inline-review";
import {
  type RelativePositionRuntime,
  relativePositionForIndex,
  relativePositionRuntimeFromState,
  resolveRelativePosition,
} from "./relative-position-runtime";

/** A point in the document that survives the editor being replaced. */
type PlacePoint = {
  /** The top-level block holding it, counted without blocks a Discard in flight hides. */
  block: number;
  /** Distance from the start of that block. */
  offset: number;
  /** Its Yjs identity, when the item survives into the successor. */
  rel: Uint8Array | null;
};

export type ReviewPlace = {
  viewport: {
    block: number;
    /** The first visible block's first character, when it survives. */
    rel: Uint8Array | null;
    /** The block's top edge below the pane's top edge, in pixels. */
    offset: number;
  } | null;
  caret: { anchor: PlacePoint; head: PlacePoint } | null;
  /** The editor had the writer's focus when they acted. */
  focus: boolean;
  /**
   * Where the writer asked to go while this place was held (the keys of the
   * change they stepped to). It replaces the held viewport: it is theirs, and
   * newer, and it names a change by what it is, not by an id of a dead generation.
   */
  navigateTo?: readonly string[];
};

const RESTORING_CLASS = "meridian-review-restoring";
const places = new Map<string, ReviewPlace>();

/**
 * The writer chose a change to go to (stepper, list row) in this draft's review.
 * Only a place already held for that draft takes it: with none, the editor on
 * screen simply scrolls.
 */
export function noteReviewNavigation(key: string, changeKeys: readonly string[]): void {
  const place = places.get(key);
  if (place) place.navigateTo = changeKeys;
}

function paneOf(editor: Editor): HTMLElement | null {
  return editor.isDestroyed ? null : editor.view.dom.closest<HTMLElement>(".meridian-editor");
}

function paneTop(pane: HTMLElement): number {
  return pane.getBoundingClientRect().top + pane.clientTop;
}

/** The block's index among those a successor will have: hidden-by-Discard blocks are not counted. */
function stableIndex(editor: Editor, index: number): number {
  let counted = 0;
  let position = 0;
  const { doc } = editor.state;
  for (let i = 0; i < index && i < doc.childCount; i += 1) {
    const dom = editor.view.nodeDOM(position);
    if (!(dom instanceof HTMLElement && dom.classList.contains(RESTORING_CLASS))) counted += 1;
    position += doc.child(i).nodeSize;
  }
  return counted;
}

/** Position of the `block`th top-level block that is not hidden, counting as `stableIndex` does. */
function blockPosition(editor: Editor, block: number): number | null {
  const { doc } = editor.state;
  let counted = 0;
  let position = 0;
  for (let i = 0; i < doc.childCount; i += 1) {
    const dom = editor.view.nodeDOM(position);
    const hidden = dom instanceof HTMLElement && dom.classList.contains(RESTORING_CLASS);
    if (!hidden) {
      if (counted === block) return position;
      counted += 1;
    }
    position += doc.child(i).nodeSize;
  }
  return null;
}

function encode(runtime: RelativePositionRuntime | null, position: number): Uint8Array | null {
  const rel = runtime ? relativePositionForIndex(runtime, position) : null;
  return rel ? Y.encodeRelativePosition(rel) : null;
}

function pointAt(
  editor: Editor,
  runtime: RelativePositionRuntime | null,
  position: number,
): PlacePoint {
  const $position = editor.state.doc.resolve(position);
  const index = $position.index(0);
  const start = $position.depth > 0 ? $position.before(1) : position;
  return {
    block: stableIndex(editor, index),
    offset: position - start,
    rel: encode(runtime, position),
  };
}

function resolvePoint(
  editor: Editor,
  runtime: RelativePositionRuntime | null,
  point: PlacePoint,
): number | null {
  const size = editor.state.doc.content.size;
  if (point.rel && runtime) {
    try {
      const resolved = resolveRelativePosition(runtime, Y.decodeRelativePosition(point.rel));
      if (resolved !== null) return resolved;
    } catch {
      // A malformed or foreign anchor falls back to the block.
    }
  }
  const start = blockPosition(editor, point.block);
  if (start === null) return null;
  const node = editor.state.doc.nodeAt(start);
  return Math.min(start + Math.min(point.offset, Math.max(0, (node?.nodeSize ?? 1) - 1)), size);
}

/**
 * Remember where the writer is in the editor on screen under `key`. Nothing
 * is kept for an editor with no layout (hidden or not yet shown): the place of
 * an earlier capture stays.
 */
export function captureReviewPlace(key: string, editor: Editor, focus: boolean): void {
  const pane = paneOf(editor);
  if (!pane?.clientHeight) return;
  try {
    const runtime = relativePositionRuntimeFromState(editor.state);
    const top = paneTop(pane);
    let viewport: ReviewPlace["viewport"] = null;
    let position = 0;
    editor.state.doc.forEach((node, _offset, index) => {
      const start = position;
      position += node.nodeSize;
      if (viewport) return;
      const dom = editor.view.nodeDOM(start);
      if (!(dom instanceof HTMLElement) || dom.classList.contains(RESTORING_CLASS)) return;
      const rect = dom.getBoundingClientRect();
      if (!rect.height || rect.bottom <= top) return;
      viewport = {
        block: stableIndex(editor, index),
        rel: node.nodeSize > 2 ? encode(runtime, start + 1) : null,
        offset: rect.top - top,
      };
    });
    const { anchor, head } = editor.state.selection;
    places.set(key, {
      viewport,
      caret: {
        anchor: pointAt(editor, runtime, anchor),
        head: pointAt(editor, runtime, head),
      },
      focus,
    });
  } catch {
    // A place is a convenience; a document that cannot answer keeps the earlier one.
  }
}

export function hasReviewPlace(key: string): boolean {
  return places.has(key);
}

export function dropReviewPlace(key: string): void {
  places.delete(key);
}

/** Focus may return only while nobody else has taken it: the body, a detached control, the cover's status line. */
function focusIsFree(): boolean {
  const active = document.activeElement;
  return (
    !active ||
    active === document.body ||
    !active.isConnected ||
    active.hasAttribute("data-paint-status")
  );
}

/**
 * Put the held place into `editor`, once, and forget it. Selection first (never
 * scrolled to), then the viewport, then focus. Returns false, keeping the
 * place, when the editor has no layout yet.
 */
export function restoreReviewPlace(
  key: string,
  editor: Editor,
  /** Where the reader of the paint cover that stood in for the old editor had scrolled to, if they did. */
  coverView?: CoverView | null,
): boolean {
  const place = places.get(key);
  if (!place) return true;
  const pane = paneOf(editor);
  if (!pane) {
    places.delete(key);
    return true;
  }
  if (!pane.clientHeight) return false;
  places.delete(key);
  try {
    const runtime = relativePositionRuntimeFromState(editor.state);
    if (place.caret) {
      const from = resolvePoint(editor, runtime, place.caret.anchor);
      const to = resolvePoint(editor, runtime, place.caret.head);
      if (from !== null) {
        const { doc } = editor.state;
        const end = to ?? from;
        const selection =
          doc.resolve(from).parent.inlineContent && doc.resolve(end).parent.inlineContent
            ? TextSelection.create(doc, from, end)
            : Selection.near(doc.resolve(from));
        editor.view.dispatch(
          editor.state.tr.setSelection(selection).setMeta("addToHistory", false),
        );
      }
    }
    const destination = place.navigateTo && operationOfChange(editor, place.navigateTo);
    if (destination) editor.commands.scrollInlineReviewOperationIntoView(destination);
    else if (coverView) restoreViewport(editor, pane, runtime, { ...coverView, rel: null });
    else if (place.viewport) restoreViewport(editor, pane, runtime, place.viewport);
    if (place.focus && editor.isEditable && focusIsFree()) editor.view.focus();
    // The live editor of a finished review is inert until the server answers: focus waits for it.
    else if (place.focus && !editor.isEditable)
      places.set(key, { viewport: null, caret: null, focus: true });
  } catch {
    // Deleted anchors and unavailable layout are convenience loss, never a broken editor.
  }
  return true;
}

/** Where a reader of a paint cover is: its first visible block, counted as the editor that replaces it will have it. */
export type CoverView = { block: number; offset: number };

const NOT_A_BLOCK =
  ".meridian-review-bar-slot,.meridian-review-removal-block,.meridian-review-restoring";

export function readCoverView(cover: HTMLElement): CoverView | null {
  const pane = cover.querySelector<HTMLElement>(".meridian-editor");
  const prose = pane?.querySelector<HTMLElement>(".ProseMirror");
  if (!pane || !prose) return null;
  const top = paneTop(pane);
  let block = 0;
  for (const element of Array.from(prose.children)) {
    // Widgets and hidden insertions are drawn here and not blocks of the successor.
    if (element.matches(NOT_A_BLOCK)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.height > 0 && rect.bottom > top) return { block, offset: rect.top - top };
    block += 1;
  }
  return null;
}

/** The successor's operation for a change the writer chose, found by what it is. */
function operationOfChange(editor: Editor, keys: readonly string[]): string | null {
  const wanted = new Set(keys);
  const model = getInlineReviewPluginState(editor.state)?.model;
  return model?.operations.find((op) => wanted.has(operationKey(op)))?.operationId ?? null;
}

function restoreViewport(
  editor: Editor,
  pane: HTMLElement,
  runtime: RelativePositionRuntime | null,
  viewport: NonNullable<ReviewPlace["viewport"]>,
): void {
  let position: number | null = null;
  if (viewport.rel && runtime) {
    try {
      const resolved = resolveRelativePosition(runtime, Y.decodeRelativePosition(viewport.rel));
      if (resolved !== null) {
        const $resolved = editor.state.doc.resolve(resolved);
        position = $resolved.depth > 0 ? $resolved.before(1) : resolved;
      }
    } catch {
      // Falls back to the block's place among the successor's blocks.
    }
  }
  position ??= blockPosition(editor, viewport.block);
  if (position === null) return;
  const dom = editor.view.nodeDOM(position);
  if (!(dom instanceof HTMLElement)) return;
  pane.scrollTop += dom.getBoundingClientRect().top - paneTop(pane) - viewport.offset;
}

/** `restoreReviewPlace`, retried when an editor without layout (a hidden pane) first gets some. */
export function restoreReviewPlaceWhenMeasured(
  key: string,
  editor: Editor,
  coverView?: CoverView | null,
): void {
  if (restoreReviewPlace(key, editor, coverView)) return;
  const pane = paneOf(editor);
  if (!pane) return;
  const observer = new ResizeObserver(() => {
    if (editor.isDestroyed || restoreReviewPlace(key, editor, coverView)) observer.disconnect();
  });
  observer.observe(pane);
  setTimeout(() => observer.disconnect(), 5_000);
}
