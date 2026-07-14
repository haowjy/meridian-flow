/**
 * The editor's prose column — ONE geometry, owned here.
 *
 * Every editor surface (tracked and temp) shares a centered 48rem column.
 * Chrome rows (toolbar, temp save bar) must start exactly where the prose
 * starts, so nothing jumps when switching tabs or when chrome appears.
 *
 * The horizontal inset is split across two layers for click behavior — the
 * ProseMirror node's own padding is click-to-focus territory, the wrapper's
 * is not — which creates the sum invariant these recipes encode in one place:
 *
 *   chrome inset  =  canvas wrapper inset  +  prose inset
 *   px-8/10/16    =  px-2/4/6              +  px-6/6/10
 *
 * Change any inset only by editing this file; never re-encode these classes
 * at a call site.
 */
import { cn } from "@/lib/utils";

/** Chrome rows aligned to the prose edge (toolbar row, temp save bar). */
export const editorColumnChrome = "mx-auto w-full max-w-3xl px-8 sm:px-10 md:px-16";

/** The scrolling canvas wrapper around `EditorContent`. */
export const editorColumnCanvas = "mx-auto w-full max-w-3xl px-2 sm:px-4 md:px-6";

/**
 * ProseMirror node classes (TipTap `editorProps.attributes.class`).
 * The top inset depends on the toolbar: the docked row already provides the
 * breathing room, so the prose trims its own reserve. Chosen at editor
 * creation — hosts don't toggle the toolbar after mount.
 */
export function editorProseClass(toolbar: "docked" | "none"): string {
  return cn(
    "prose-tokens min-h-full px-6 pb-6 md:px-10 md:pb-8",
    toolbar === "docked" ? "pt-4" : "pt-6 md:pt-8",
  );
}
