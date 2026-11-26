import { cn } from "@/lib/utils";

export const editorColumnChrome =
  "mx-auto w-full max-w-4xl px-4 @md:pr-8 @md:pl-12 @2xl:px-14 @3xl:px-16";

/**
 * Fill chain for `EditorContent`, so the ProseMirror
 * node reaches the bottom of the scroll area — clicking below the last line
 * must land in the editor. Percentage `min-h-full` alone breaks here: a
 * min-height-driven parent is not a definite height, so the child's
 * percentage resolves to auto and the prose node collapses to its content.
 * Definite flex heights (`flex-1` down the chain) are what make it resolve.
 */
export const editorColumnFill = "flex min-h-full flex-1 flex-col";

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
    "[--prose-lead:3rem] [--prose-trail:2rem] @2xl:[--prose-lead:3.5rem] @2xl:[--prose-trail:3.5rem] @3xl:[--prose-lead:4rem] @3xl:[--prose-trail:4rem]",
    "pl-[calc(max(0px,(100%-56rem)/2)+var(--prose-lead))]",
    "pr-[max(calc(max(0px,(100%-56rem)/2)+var(--prose-trail)),calc(100%-max(0px,(100%-56rem)/2)-var(--prose-lead)-76ch+5rem))]",
    editorProseScrollPastEnd,
    toolbar === "docked" ? "pt-5" : "pt-6 md:pt-8",
  );
}
