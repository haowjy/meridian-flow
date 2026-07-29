/**
 * The editor's prose column — ONE geometry, owned here.
 *
 * Every editor surface (tracked and temp) shares a centered 48rem column.
 *
 * The horizontal inset is split across two layers — a wrapper and the
 * ProseMirror node's own padding. The whole editor pane is click-to-focus
 * territory (EditorSurfaceFrame routes gutter presses to the caret), so the
 * split is pure geometry now; the sum these recipes encode is the column
 * edge any future chrome row must align to:
 *
 *   column edge   =  canvas wrapper inset  +  prose inset
 *   px-8/10/16    =  px-2/4/6              +  px-6/6/10
 *
 * Change any inset only by editing this file; never re-encode these classes
 * at a call site.
 */

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
 * ProseMirror node classes (TipTap `editorProps.attributes.class`).
 * The manuscript carries no chrome above it, so the prose owns its own top
 * reserve. The bottom inset keeps the active line away from the viewport edge
 * in long manuscripts.
 */
export const editorProseClass = "prose-tokens min-h-full px-6 pt-6 pb-[50vh] md:px-10 md:pt-8";
