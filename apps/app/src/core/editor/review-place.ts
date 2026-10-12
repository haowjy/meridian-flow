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

import { getBlockItemId } from "@meridian/agent-edit";
import { blockItemKey, operationKey } from "@meridian/contracts/drafts";
import type { Editor } from "@tiptap/core";
import { Selection, TextSelection } from "@tiptap/pm/state";
import * as Y from "yjs";
import {
  BLOCK_ID_ATTR,
  getInlineReviewPluginState,
  inlineReviewClassNames,
  REMOVED_BLOCKS_ATTR,
} from "./extensions/inline-review";
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

const RESTORING_CLASS = inlineReviewClassNames.restoring;
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

const classes = inlineReviewClassNames;
/** Drawn by the review among the document's blocks without being one. */
const WIDGETS = `.${classes.barSlot},.${classes.removal},.ProseMirror-gapcursor`;

/** The elements an editor draws for its top-level blocks, in order, with its widgets left out. */
function blockElements(prose: Element): HTMLElement[] {
  return Array.from(prose.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && !child.matches(WIDGETS),
  );
}

/**
 * The editor's top-level blocks as a successor will count them: where each is, its
 * element, and whether a Discard in flight hides it. One pass; the elements pair with
 * the document by order, and by position (`nodeDOM`) only if the two do not agree in number.
 */
type BlockLayout = {
  blocks: { position: number; element: HTMLElement | null; hidden: boolean }[];
  /** For a block, how many blocks before it are shown: its index among those a successor will have. */
  shownBefore: number[];
  shown: number;
};

function blockLayout(editor: Editor): BlockLayout {
  const { doc } = editor.state;
  const elements = blockElements(editor.view.dom);
  const paired = elements.length === doc.childCount;
  const blocks: BlockLayout["blocks"] = [];
  const shownBefore: number[] = [];
  let shown = 0;
  let position = 0;
  doc.forEach((node) => {
    const element = paired
      ? (elements[blocks.length] ?? null)
      : ((editor.view.nodeDOM(position) as HTMLElement | null) ?? null);
    const hidden = element?.classList.contains(RESTORING_CLASS) ?? false;
    blocks.push({ position, element, hidden });
    shownBefore.push(shown);
    if (!hidden) shown += 1;
    position += node.nodeSize;
  });
  return { blocks, shownBefore, shown };
}

/** Position of the `block`th block a successor shows. */
function blockPosition(layout: BlockLayout, block: number): number | null {
  return (
    layout.blocks.find((entry, at) => !entry.hidden && layout.shownBefore[at] === block)
      ?.position ?? null
  );
}

function encode(runtime: RelativePositionRuntime | null, position: number): Uint8Array | null {
  const rel = runtime ? relativePositionForIndex(runtime, position) : null;
  return rel ? Y.encodeRelativePosition(rel) : null;
}

function pointAt(
  editor: Editor,
  runtime: RelativePositionRuntime | null,
  layout: BlockLayout,
  position: number,
): PlacePoint {
  const $position = editor.state.doc.resolve(position);
  const index = $position.index(0);
  const start = $position.depth > 0 ? $position.before(1) : position;
  return {
    block: layout.shownBefore[index] ?? layout.shown,
    offset: position - start,
    rel: encode(runtime, position),
  };
}

function resolvePoint(
  editor: Editor,
  runtime: RelativePositionRuntime | null,
  layout: BlockLayout,
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
  const start = blockPosition(layout, point.block);
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
    const layout = blockLayout(editor);
    let viewport: ReviewPlace["viewport"] = null;
    for (const [index, { position, element, hidden }] of layout.blocks.entries()) {
      if (!element || hidden) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.height || rect.bottom <= top) continue;
      viewport = {
        block: layout.shownBefore[index] ?? 0,
        rel:
          (editor.state.doc.child(index).nodeSize ?? 0) > 2 ? encode(runtime, position + 1) : null,
        offset: rect.top - top,
      };
      break;
    }
    const { anchor, head } = editor.state.selection;
    places.set(key, {
      viewport,
      caret: {
        anchor: pointAt(editor, runtime, layout, anchor),
        head: pointAt(editor, runtime, layout, head),
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
    const layout = blockLayout(editor);
    if (place.caret) {
      const from = resolvePoint(editor, runtime, layout, place.caret.anchor);
      const to = resolvePoint(editor, runtime, layout, place.caret.head);
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
    else if (coverView) {
      restoreViewport(editor, pane, runtime, layout, {
        block: blockOfCoverView(editor, runtime, layout, coverView),
        offset: coverView.offset,
        rel: null,
      });
    } else if (place.viewport) restoreViewport(editor, pane, runtime, layout, place.viewport);
    if (place.focus && editor.isEditable && focusIsFree()) editor.view.focus();
    // The live editor of a finished review is inert until the server answers: focus waits for it.
    else if (place.focus && !editor.isEditable)
      places.set(key, { viewport: null, caret: null, focus: true });
  } catch {
    // Deleted anchors and unavailable layout are convenience loss, never a broken editor.
  }
  return true;
}

/**
 * Where a reader of a paint cover is: the first block they can see, named by the
 * block's own Yjs item (`blockItemKey`), never by what it says. A real block of
 * the old review carries it from capture (`annotateCoverBlocks`). The original
 * paragraph a Discard restores carries the live block it was, which the removal
 * widget got from the server; the successor has that same item.
 */
export type CoverView = {
  /** The first block in view: its item. Null when nothing named it. */
  id: string | null;
  /**
   * Approximate, for a block with no usable item: the nearest block that has one
   * and the blocks between. A block inserted between them moves the answer.
   */
  near: { id: string; step: number } | null;
  /** Approximate, for a cover with no items at all: the block counted among those a successor shows. */
  block: number;
  /** The first in view, its top edge below the pane's top edge, in pixels. */
  offset: number;
};

/**
 * The Yjs item of each top-level block of an editor, in order, from one walk of
 * its binding. Null when the binding and the document do not pair block for block
 * (a block y-tiptap does not draw), in which case nothing is claimed.
 */
function blockKeys(editor: Editor, runtime: RelativePositionRuntime | null): string[] | null {
  if (!runtime) return null;
  const elements = runtime.yFragment.toArray();
  const { doc } = editor.state;
  if (elements.length !== doc.childCount) return null;
  try {
    return elements.map((element, index) => {
      if (!(element instanceof Y.XmlElement) || element.nodeName !== doc.child(index).type.name)
        throw new Error("The binding and the document do not pair.");
      return blockItemKey(getBlockItemId(element));
    });
  } catch {
    return null;
  }
}

/**
 * Stamp each real top-level block of the editors on `live` onto its copy in
 * `copy` with its Yjs item. A cover is a copy of the DOM, which knows no Yjs; the
 * identity can only be read while the editor lives. One pass over blocks, elements
 * and copies, whatever the length of the document.
 */
export function annotateCoverBlocks(live: HTMLElement, copy: HTMLElement): void {
  const copies = copy.querySelectorAll<HTMLElement>(".ProseMirror");
  for (const [index, dom] of live.querySelectorAll<HTMLElement>(".ProseMirror").entries()) {
    const editor = (dom as { editor?: Editor }).editor;
    const target = copies[index];
    if (!editor || editor.isDestroyed || !target || dom.closest('[data-paint-scope="inactive"]'))
      continue;
    const keys = blockKeys(editor, relativePositionRuntimeFromState(editor.state));
    const elements = blockElements(dom);
    const stamped = blockElements(target);
    if (!keys || elements.length !== keys.length || stamped.length !== keys.length) continue;
    for (const [at, key] of keys.entries()) stamped[at]?.setAttribute(BLOCK_ID_ATTR, key);
  }
}

/** One block of the successor as the cover shows it: the cover's own block or an original it restores. */
type Slot = { element: HTMLElement; id: string | null; real: boolean };

/** The blocks of a cover's editor, in order, as the successor will have them. */
function coverSlots(prose: HTMLElement): Slot[] {
  const slots: Slot[] = [];
  for (const element of Array.from(prose.children)) {
    if (!(element instanceof HTMLElement)) continue;
    if (element.classList.contains(classes.restored)) {
      // The widget says how many blocks it stands for; its paragraphs say which.
      const count = Number(element.getAttribute(REMOVED_BLOCKS_ATTR)) || 0;
      const paragraphs = Array.from(element.children).filter((child) => child.tagName === "P");
      for (let i = 0; i < count; i += 1) {
        const paragraph = paragraphs.length === count ? (paragraphs[i] as HTMLElement) : null;
        slots.push({
          element: paragraph ?? element,
          id: paragraph?.getAttribute(BLOCK_ID_ATTR) ?? null,
          real: false,
        });
      }
    } else if (!element.matches(`${WIDGETS},.${classes.restoring}`)) {
      slots.push({ element, id: element.getAttribute(BLOCK_ID_ATTR), real: true });
    }
  }
  return slots;
}

export function readCoverView(cover: HTMLElement): CoverView | null {
  const pane = cover.querySelector<HTMLElement>(".meridian-editor");
  const prose = pane?.querySelector<HTMLElement>(".ProseMirror");
  if (!pane || !prose) return null;
  const top = paneTop(pane);
  const slots = coverSlots(prose);
  const block = slots.findIndex(({ element }) => {
    const rect = element.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > top;
  });
  const first = slots[block];
  if (!first) return null;
  // The nearest stamped real block: the next (the originals a Discard restores
  // stand just before it), else the last before.
  let from = slots.findIndex((slot, at) => at >= block && slot.real && slot.id !== null);
  for (let at = block - 1; from < 0 && at >= 0; at -= 1)
    if (slots[at]?.real && slots[at]?.id) from = at;
  const named = from >= 0 ? slots[from]?.id : null;
  return {
    id: first.id,
    near: named ? { id: named, step: block - from } : null,
    block,
    offset: first.element.getBoundingClientRect().top - top,
  };
}

/**
 * The successor's block (counted among those it shows) for what the cover's
 * reader saw. The block's own item is looked up in a table of the successor's
 * items, built once: an item the successor does not have names nothing. Only
 * then the approximate answers, in order: the nearest stamped block and the steps
 * from it, the counted block.
 */
function blockOfCoverView(
  editor: Editor,
  runtime: RelativePositionRuntime | null,
  layout: BlockLayout,
  view: CoverView,
): number {
  const clamp = (block: number) => Math.max(0, Math.min(block, layout.shown - 1));
  const keys = view.id || view.near ? blockKeys(editor, runtime) : null;
  const table = new Map(keys?.map((key, at) => [key, at]));
  const index = (id: string | undefined | null) => (id ? (table.get(id) ?? null) : null);
  const exact = index(view.id);
  if (exact !== null) return clamp(layout.shownBefore[exact] ?? 0);
  const nearest = index(view.near?.id);
  if (nearest !== null && view.near)
    return clamp((layout.shownBefore[nearest] ?? 0) + view.near.step);
  return clamp(view.block);
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
  layout: BlockLayout,
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
  position ??= blockPosition(layout, viewport.block);
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
