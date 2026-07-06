/**
 * Markdown renderer wrapper around Streamdown with Meridian's prose tokens and streaming block collapse behavior.
 */
import { Streamdown, type StreamdownProps } from "streamdown";

import { cn } from "@/lib/utils";

import { collapseMarkdownBlocks } from "./collapse-markdown-blocks";

export type MarkdownProps = {
  children: string;
  /**
   * Visual treatment:
   *  - `answer`  → reading-scale prose (assistant answers AND user turns —
   *    conversation text shares one size with the editor).
   *  - `compact` → dense meta rows (tool output, helper summaries).
   */
  variant?: "answer" | "compact";
  /**
   *  - `streaming` → live frontier; uses block splitting + collapse helper.
   *  - `static` → settled content; single markdown tree.
   */
  mode?: "streaming" | "static";
  className?: string;
};

const SHIKI_THEME: NonNullable<StreamdownProps["shikiTheme"]> = ["github-light", "github-dark"];

const CONTROLS = { code: true, table: false, mermaid: false } as const;

const VARIANT_CLASS: Record<NonNullable<MarkdownProps["variant"]>, string> = {
  answer: "",
  compact: "text-compact text-foreground",
};

/**
 * Thin Streamdown shell. Warm Organic element styling lives in `globals.css`
 * under `.prose-tokens` — not a full `components` override map.
 */
export function Markdown({
  children,
  variant = "answer",
  mode = "static",
  className,
}: MarkdownProps) {
  const streaming = mode === "streaming";

  return (
    <Streamdown
      mode={mode}
      isAnimating={streaming}
      parseMarkdownIntoBlocksFn={streaming ? collapseMarkdownBlocks : undefined}
      shikiTheme={SHIKI_THEME}
      controls={CONTROLS}
      className={cn("prose-tokens", VARIANT_CLASS[variant], streaming && "space-y-2", className)}
    >
      {children}
    </Streamdown>
  );
}
