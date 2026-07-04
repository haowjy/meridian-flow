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
   *  - `answer`  → editorial answer body (`prose-tokens`).
   *  - `thinking` → muted, italic reasoning voice.
   *  - `compact` → bubble bodies (user turn, dense rows).
   */
  variant?: "answer" | "thinking" | "compact";
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
  thinking: "text-compact text-muted-foreground italic",
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
