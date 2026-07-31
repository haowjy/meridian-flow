/**
 * Where the chrome goes: the margin the handle sits in, and the seam a
 * dragging pointer is asking for.
 *
 * The document half of block movement is positions (`block-targets.ts`); this
 * is the half that has to look at what the browser actually drew. Both the
 * handle and the drop line are overlays measured from the rendered boxes, never
 * elements inside the prose — law 7 forbids chrome that moves a line of the
 * manuscript, and a widget decoration between two blocks would inherit the
 * manuscript's own block spacing and push the page down by exactly its height.
 *
 * **Everything drawn is in the manuscript overlay's coordinates**
 * (`features/editor/chrome/manuscript-overlay.ts`); everything READ from a
 * pointer stays in the viewport's, because a pointer event speaks no other
 * language. Placed against the viewport instead, the handle was a frame behind
 * every scroll and had nothing clipping it: measured mid-scroll at the top of
 * the WINDOW, fully opaque, over the app's breadcrumb.
 */

import type { EditorView } from "@tiptap/pm/view";

import { type ObjectBody, objectBody } from "@/core/editor/objects";
// Straight at the primitive rather than through `chrome/index.ts`: that barrel
// also carries the surface registry this lane is listed in, so the barrel route
// is a module cycle.
import { type OverlayBox, overlayRect } from "@/features/editor/chrome/manuscript-overlay";

import { type BlockTarget, blockAt, objectIsWholeBlock } from "./block-targets";

/** Matches mockup 08: a 22×24 grip. */
export const BLOCK_HANDLE_WIDTH = 22;
export const BLOCK_HANDLE_HEIGHT = 24;

/**
 * How far the handle's right edge sits inside the text edge.
 *
 * The left margin is shared with the table's row grips, and the two used to
 * overlap by 10px — whichever painted on top took the right-click for both.
 * The ruling splits the band: the handle keeps the OUTER part and the grips the
 * inner one, because a grip belongs beside the row it serves while the handle
 * is a document-level control (M6's `table/.context/CONTEXT.md` records the
 * same split from the other side).
 *
 * 22 is what makes the split true: a row grip starts `ROW_GRIP_GAP` + its own
 * 15px width inside the frame, so 21, and the handle's right edge lands one
 * pixel clear of it. Measured against the text edge rather than the viewport
 * so it holds at every column width. Growing it moves the handle further from
 * the text, which is allowed; shrinking it walks back into the grip band,
 * which is the bug.
 */
const HANDLE_CLEARANCE = 22;

/**
 * How much gutter the prose column has to leave left of its text edge.
 *
 * The handle is drawn IN the manuscript's pane and the pane clips what leaves
 * it, so the gutter stopped being a matter of taste the moment the portal
 * moved: a gutter narrower than the handle reaches is a control the writer can
 * see part of and grab part of. A 32px base-breakpoint gutter left 10px of a
 * 22px grip — on the phone editor, and in any desktop window under 640px.
 *
 * 44 of this is the band itself (`HANDLE_CLEARANCE` plus the grip's own
 * width). The remaining 4 is deliberate slack rather than rounding: a rounded
 * control with a hover background, flush against a clip edge, reads as cut off
 * rather than as a control, and the reserve is what keeps the next change to
 * either number from landing back on an exact fit.
 *
 * `editor-column.ts` owns the gutter and `editor-column.test.ts` holds the two
 * together — Tailwind class strings are literal, so nothing here can read
 * them.
 */
export const MARGIN_GUTTER_MIN = HANDLE_CLEARANCE + BLOCK_HANDLE_WIDTH + 4;

/** How far the drop line floats off the outer edges of the document. */
const END_SEAM_OFFSET = 6;

/**
 * Slack around a block's box when deciding whether the pointer is on it, so a
 * pointer crossing the gap between two paragraphs does not fall into nothing
 * and blink the handle off. Half the manuscript's own block spacing.
 */
const BLOCK_HOVER_SLACK_PX = 8;

type ColumnEdges = { left: number; right: number };

/** The rendered element of a top-level block, or null when it has none yet. */
export function blockElement(view: EditorView, pos: number): HTMLElement | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
}

/**
 * The prose column's left and right text edges: inside the ProseMirror node's
 * own padding. The drop line spans them and the handle hangs off the left, so
 * both agree with the column rather than with whichever block happens to be
 * adjacent (a centered table is narrower than the paragraph above it).
 *
 * Horizontal only, deliberately. The prose node reserves half a viewport of
 * padding under the last line so a writer can keep typing mid-screen, so its
 * box says nothing useful about where the manuscript ends.
 */
function proseColumnEdges(view: EditorView, overlay: HTMLElement): ColumnEdges | null {
  const rect = overlayRect(overlay, view.dom);
  if (!rect) return null;
  const style = window.getComputedStyle(view.dom);
  return {
    left: rect.left + pixels(style.paddingLeft),
    right: rect.right - pixels(style.paddingRight),
  };
}

/**
 * Where the handle for `block` sits, in the overlay's coordinates.
 *
 * Vertically it aligns with the block's first LINE rather than its box, so it
 * reads as belonging to the sentence beside it: a heading's line is taller
 * than a paragraph's and a code fence's text starts below its own padding.
 */
export function blockHandlePosition(
  view: EditorView,
  overlay: HTMLElement,
  block: BlockTarget,
): { top: number; left: number } | null {
  const element = blockElement(view, block.pos);
  if (!element) return null;

  const rect = overlayRect(overlay, element);
  const column = proseColumnEdges(view, overlay);
  if (!rect || !column) return null;

  const style = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const lead = Number.isFinite(lineHeight)
    ? Math.max(0, (lineHeight - BLOCK_HANDLE_HEIGHT) / 2)
    : 4;

  return {
    top: rect.top + pixels(style.paddingTop) + lead,
    left: column.left - HANDLE_CLEARANCE - BLOCK_HANDLE_WIDTH,
  };
}

/**
 * The block the pointer is on, or null when it is on none.
 *
 * Two corrections to `posAtCoords`, both about approach chrome rather than
 * carets. X is pulled into the column first, because the pointer spends the
 * whole approach in the margin where the prose node has nothing to say. And
 * the answer is checked against the block's own box, because the prose node
 * keeps answering far below the last line (it reserves half a viewport of
 * padding there) and a handle floating beside blank page belongs to nothing.
 */
export function blockUnderPointer(
  view: EditorView,
  clientX: number,
  clientY: number,
): BlockTarget | null {
  const column = proseColumnEdgesInViewport(view);
  const at = view.posAtCoords({
    left: Math.min(Math.max(clientX, column.left + 1), column.right - 1),
    top: clientY,
  });
  if (!at) return null;

  const block = blockAt(view.state.doc, at.pos);
  if (!block) return null;
  const rect = blockElement(view, block.pos)?.getBoundingClientRect();
  if (!rect) return null;
  return clientY >= rect.top - BLOCK_HOVER_SLACK_PX && clientY <= rect.bottom + BLOCK_HOVER_SLACK_PX
    ? block
    : null;
}

/**
 * Controls a node view puts inside its own body: a figure's alt and caption
 * fields, an image's retry button. A press on one of those is about the
 * control, and it is still not a drag the browser may run away with.
 */
const OBJECT_BODY_CONTROLS = "input, textarea, select, button, a[href]";

/**
 * The block a press on an object's body should drag, or null when the press
 * starts no block drag (§5.8).
 *
 * `posAtCoords` reports `inside`: the innermost node the coordinates landed in,
 * which for a picture is the picture and for a sentence is its paragraph. The
 * registry then says which drag that body starts, so prose, table cells, and
 * the objects that land inline all decline by being what they are, without a
 * node name here.
 *
 * The pointer's own x, not the column-corrected x `blockUnderPointer` uses: a
 * press in the margin beside a picture is a press on the margin.
 *
 * What moves is the object's top-level block, the same unit the margin handle
 * points at — so the object has to BE that block. A figure inside a list item
 * beside a paragraph is not, and grabbing it would carry prose nobody took
 * hold of; the margin handle still moves that whole line.
 */
export function objectBodyDragTarget(view: EditorView, event: PointerEvent): BlockTarget | null {
  if (!(event.target instanceof Element)) return null;
  if (onEditableText(event.target) || event.target.closest(OBJECT_BODY_CONTROLS)) return null;

  const object = objectAtPointer(view, event.clientX, event.clientY, "block-drag");
  if (object === null || !objectIsWholeBlock(view.state.doc, object)) return null;
  return blockAt(view.state.doc, object);
}

/**
 * True when the browser's own drag would carry a BLOCK object off.
 *
 * ProseMirror's drag is the right one for an object that lands inline: it
 * carries an inline slice, the dropcursor draws the caret between characters,
 * and the drop is one transaction that undo takes back in a step. It is the
 * wrong one for a block object, which shows no block drop line under it and
 * travels by serialize-and-reparse — the route that once brought a figure back
 * as a bare paragraph.
 *
 * A wider question than where a block drag may begin, and deliberately so: a
 * press on a figure's caption field belongs to the field, but a native drag
 * out of it still takes the whole figure. Text the writer selected inside a
 * source fence is the one thing still theirs to drag.
 */
export function nativeDragCarriesObject(view: EditorView, event: DragEvent): boolean {
  if (event.target instanceof Element && onEditableText(event.target)) return false;
  return objectAtPointer(view, event.clientX, event.clientY, "block-drag") !== null;
}

/**
 * True when the element is text the writer can type into, rather than the
 * inert surface a node view draws in front of its own content.
 *
 * This is what keeps a mermaid fence honest. The same node is a diagram when
 * it renders and its own source when the caret is inside it, and one
 * registration cannot say which — but the DOM can: ProseMirror owns that
 * text, and everything standing in for it is `contenteditable="false"`.
 */
function onEditableText(element: Element): boolean {
  return element.closest("[contenteditable]")?.getAttribute("contenteditable") !== "false";
}

/**
 * The position of the object under these coordinates whose body is `body`, or
 * null when the coordinates are on something else.
 */
function objectAtPointer(
  view: EditorView,
  clientX: number,
  clientY: number,
  body: ObjectBody,
): number | null {
  const at = view.posAtCoords({ left: clientX, top: clientY });
  if (!at || at.inside < 0) return null;
  const node = view.state.doc.nodeAt(at.inside);
  return node && objectBody(node) === body ? at.inside : null;
}

/**
 * Which seam the pointer is asking for: the nearest edge of the block it is
 * over, above or below its middle. Off the top of the document it is the first
 * seam and off the bottom the last, so a pointer dragged past the end still
 * has an answer rather than losing the line.
 */
export function seamIndexAtPointer(view: EditorView, clientY: number): number {
  const { doc } = view.state;
  let pos = 0;

  for (let index = 0; index < doc.childCount; index += 1) {
    const element = blockElement(view, pos);
    pos += doc.child(index).nodeSize;
    if (!element) continue;

    const rect = element.getBoundingClientRect();
    if (clientY < rect.top) return index;
    if (clientY <= rect.bottom) return clientY < rect.top + rect.height / 2 ? index : index + 1;
  }

  return doc.childCount;
}

/** Where the jade line is drawn for `seamIndex`, in the overlay's coordinates. */
export function seamLinePosition(
  view: EditorView,
  overlay: HTMLElement,
  seamIndex: number,
): { top: number; left: number; width: number } | null {
  const { doc } = view.state;
  const column = proseColumnEdges(view, overlay);
  if (!column) return null;
  const geometry = { left: column.left, width: Math.max(0, column.right - column.left) };

  const above = seamIndex > 0 ? blockRectAtIndex(view, overlay, seamIndex - 1) : null;
  const below = seamIndex < doc.childCount ? blockRectAtIndex(view, overlay, seamIndex) : null;

  if (above && below) return { ...geometry, top: (above.bottom + below.top) / 2 };
  if (below) return { ...geometry, top: below.top - END_SEAM_OFFSET };
  if (above) return { ...geometry, top: above.bottom + END_SEAM_OFFSET };
  return null;
}

function blockRectAtIndex(
  view: EditorView,
  overlay: HTMLElement,
  index: number,
): OverlayBox | null {
  const { doc } = view.state;
  if (index < 0 || index >= doc.childCount) return null;
  let pos = 0;
  for (let before = 0; before < index; before += 1) pos += doc.child(before).nodeSize;
  const element = blockElement(view, pos);
  return element ? overlayRect(overlay, element) : null;
}

/**
 * The same two edges the pointer is compared against, in the pointer's space.
 *
 * A pointer event carries viewport coordinates and nothing else, so the one
 * reading this module takes FROM the writer stays there. Everything it hands
 * back to be drawn is in the overlay's coordinates instead.
 */
function proseColumnEdgesInViewport(view: EditorView): ColumnEdges {
  const rect = view.dom.getBoundingClientRect();
  const style = window.getComputedStyle(view.dom);
  return {
    left: rect.left + pixels(style.paddingLeft),
    right: rect.right - pixels(style.paddingRight),
  };
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
