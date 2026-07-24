/**
 * Markdown renderer wrapper around Streamdown with Meridian's prose tokens and streaming block collapse behavior.
 */
import { type Components, Streamdown, type StreamdownProps } from "streamdown";

import { cn } from "@/lib/utils";

import { collapseMarkdownBlocks } from "./collapse-markdown-blocks";
import {
  documentMarkdownAllowedTags,
  documentMarkdownComponents,
  documentMarkdownImageComponent,
} from "./registry-markdown";

export type MarkdownProps = {
  children: string;
  /**
   * Default is reading-scale prose (assistant answers, user turns — one
   * size with the editor). `compact` is the dense meta voice for tool
   * output and helper summaries.
   */
  variant?: "compact";
  /**
   *  - `streaming` → live frontier; uses block splitting + collapse helper.
   *  - `static` → settled content; single markdown tree.
   */
  mode?: "streaming" | "static";
  className?: string;
};

const SHIKI_THEME: NonNullable<StreamdownProps["shikiTheme"]> = ["github-light", "github-dark"];

const CONTROLS = { code: true, table: false, mermaid: false } as const;
const COMPONENTS: Components = {
  ...documentMarkdownComponents,
  img: documentMarkdownImageComponent,
};

/**
 * Thin Streamdown shell. Warm Organic element styling lives in `globals.css`
 * under `.prose-tokens` — not a full `components` override map.
 */
export function Markdown({ children, variant, mode = "static", className }: MarkdownProps) {
  const streaming = mode === "streaming";

  return (
    <Streamdown
      mode={mode}
      isAnimating={streaming}
      parseMarkdownIntoBlocksFn={streaming ? collapseMarkdownBlocks : undefined}
      shikiTheme={SHIKI_THEME}
      controls={CONTROLS}
      allowedTags={documentMarkdownAllowedTags}
      components={COMPONENTS}
      className={cn(
        "prose-tokens",
        variant === "compact" && "text-tier-compact",
        streaming && "space-y-2",
        className,
      )}
    >
      {children}
    </Streamdown>
  );
}
