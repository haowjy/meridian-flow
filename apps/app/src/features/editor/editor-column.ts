/**
 * The editor's prose column — ONE geometry, owned here.
 *
 * Every editor surface (tracked and temp) shares a centered 48rem column.
 * The document toolbar row starts exactly where the prose starts, so nothing
 * shifts when switching tabs or when a host mounts the editor without it.
 *
 * The horizontal inset is split across two layers — a wrapper and the
 * ProseMirror node's own padding. The whole editor pane is click-to-focus
 * territory (EditorSurfaceFrame routes gutter presses to the caret), so the
 * split is pure geometry now; the sum invariant these recipes encode is:
 *
 *   chrome inset  =  canvas wrapper inset  +  prose inset
 *   px-12/14/16   =  px-2/4/6              +  px-10
 *
 * That sum is also the GUTTER, and the gutter is load-bearing: the block
 * handle and the table's row grips are drawn in the manuscript's own scroll
 * pane, which clips them at its edge, so anything they reach past the text
 * edge has to fit inside it. `MARGIN_GUTTER_MIN` is what they reach
 * (`surfaces/blocks/block-geometry.ts`); every breakpoint here clears it, and
 * `editor-column.test.ts` fails if one stops.
 *
 * The ramp is in the wrapper alone — 48/56/64 — and the prose keeps one
 * padding at every width. A narrow window gives up 16px of line length for a
 * usable margin, which is the trade, and the reward is that crossing 768px no
 * longer moves the text edge by 24px per side.
 *
 * Change any inset only by editing this file; never re-encode these classes
 * at a call site.
 */

import { cn } from "@/lib/utils";

/** Chrome rows aligned to the prose edge (the document toolbar row). */
export const editorColumnChrome = "mx-auto w-full max-w-3xl px-12 sm:px-14 md:px-16";

/** The scrolling canvas wrapper around `EditorContent`. */
export const editorColumnCanvas = "mx-auto w-full max-w-3xl px-2 sm:px-4 md:px-6";

/**
 * Fill chain for the canvas wrapper AND `EditorContent`, so the ProseMirror
 * node reaches the bottom of the scroll area — clicking below the last line
 * must land in the editor. Percentage `min-h-full` alone breaks here: a
 * min-height-driven parent is not a definite height, so the child's
 * percentage resolves to auto and the prose node collapses to its content.
 * Definite flex heights (`flex-1` down the chain) are what make it resolve.
 */
export const editorColumnFill = "flex min-h-full flex-1 flex-col";

/**
 * Scroll past end: the manuscript keeps scrolling until the last block sits in
 * the upper half of the pane, so a writer never has to type against the bottom
 * edge of the screen (human ruling 2026-07-29; the reference is Notion).
 *
 * Half a viewport, which parks the last line just above the pane's midline at
 * desktop geometry. Viewport-relative rather than a fixed height so the reserve
 * stays proportional from a laptop to a large display.
 *
 * It belongs to the ProseMirror node itself rather than a wrapper: the reserve
 * is click territory, and a press inside the editable element is ProseMirror's
 * to answer with the caret at the end of the document. Chrome that measures the
 * manuscript reads block boxes, never this one, because the prose node keeps
 * answering `posAtCoords` far below the last line.
 */
export const editorProseScrollPastEnd = "pb-[50vh]";

/**
 * ProseMirror node classes (TipTap `editorProps.attributes.class`).
 * The top inset depends on the toolbar: the docked row already provides the
 * breathing room, so the prose trims its own reserve. Chosen at editor
 * creation — hosts don't toggle the toolbar after mount.
 *
 * `shrink-0` is load-bearing, not decoration. The prose node is the last link
 * in the fill chain above, so it is a flex item in a column, and `min-h-full`
 * replaces the automatic minimum size that would otherwise hold a flex item at
 * its content height. Without it the flex algorithm squashes the box back down
 * to the scroll viewport: the blocks overflow it and still scroll, but the
 * scroll-past-end reserve ends up drawn behind them instead of below the last
 * line, and the manuscript stops dead at its final block.
 */
export function editorProseClass(toolbar: "docked" | "none"): string {
  return cn(
    "prose-tokens min-h-full shrink-0 px-10",
    editorProseScrollPastEnd,
    toolbar === "docked" ? "pt-4" : "pt-6 md:pt-8",
  );
}
