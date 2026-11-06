/**
 * The editor's prose column — ONE geometry, owned here.
 *
 * Every editor surface (tracked and temp) shares a centered 48rem column.
 * The document toolbar row starts exactly where the prose starts, so nothing
 * shifts when switching tabs or when a host mounts the editor without it.
 *
 * The ProseMirror node spans the whole pane, so every press, sweep and drag in
 * the pane is inside `view.dom`. Its own padding is the whole margin: the
 * centring (whatever the pane has beyond 48rem, halved) plus the inset below.
 * The text column sits where a centered 48rem wrapper with these insets put it:
 *
 *   pane (container)   leading (handle side)   trailing
 *   < @2xl (42rem)     48                       32
 *   @2xl – @3xl        56                       56
 *   >= @3xl (48rem)    64                       64
 *
 * Every step answers to the PANE (EditorSurfaceFrame's `@container`), not the
 * viewport: the dock's document, a narrow Editor window and the phone all get
 * the narrow tiers because their pane is narrow, whatever the screen.
 *
 * Both gutters are load-bearing, because chrome drawn past the text edge lives
 * in the manuscript's own scroll pane, which clips it:
 * - LEADING holds the block handle and the table's row grips, so it never drops
 *   below `MARGIN_GUTTER_MIN` (`surfaces/blocks/block-geometry.ts`, 48px).
 * - TRAILING holds less: a full-width table's Add column tab, which reaches
 *   `ADD_TAB_GAP + ADD_TAB` = 27px past the table (`surfaces/table/table-anchors.ts`),
 *   so 32px is its floor.
 * A narrow pane gives the difference back to the line on the trailing side
 * (#744); wide panes stay symmetric around the centered 48rem column.
 *
 * Change any inset only by editing this file; never re-encode these classes
 * at a call site.
 */

import { cn } from "@/lib/utils";

/**
 * Chrome rows aligned to the prose edges (the document toolbar row). In a pane narrower than `@md` (the dock) the row stops aligning to the
 * prose and takes the identity bar's 16px inset, which is all the width a
 * toolbar has.
 */
export const editorColumnChrome =
  "mx-auto w-full max-w-3xl px-4 @md:pr-8 @md:pl-12 @2xl:px-14 @3xl:px-16";

/**
 * Fill chain for `EditorContent`, so the ProseMirror
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
 * edge of the screen, as Notion does.
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
    "prose-tokens document-prose min-h-full shrink-0",
    // Padding percentages resolve against the parent's width: the pane. The
    // trailing padding also holds the reading measure (68ch less the old 2.5rem
    // of padding either side) where the pane is wider than it.
    "[--prose-lead:3rem] [--prose-trail:2rem] @2xl:[--prose-lead:3.5rem] @2xl:[--prose-trail:3.5rem] @3xl:[--prose-lead:4rem] @3xl:[--prose-trail:4rem]",
    "pl-[calc(max(0px,(100%-48rem)/2)+var(--prose-lead))]",
    "pr-[max(calc(max(0px,(100%-48rem)/2)+var(--prose-trail)),calc(100%-max(0px,(100%-48rem)/2)-var(--prose-lead)-68ch+5rem))]",
    editorProseScrollPastEnd,
    toolbar === "docked" ? "pt-4" : "pt-6 md:pt-8",
  );
}
