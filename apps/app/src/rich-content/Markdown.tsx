/**
 * Markdown renderer wrapper around Streamdown with Meridian's prose tokens and
 * streaming block collapse behavior.
 *
 * It also teaches the renderer the two internal reference spellings a writer's
 * message can carry — `[[The Third Gate]]` and a `manuscript://` URI — which
 * markdown itself has no opinion about. They render as an element of our own
 * rather than as anchors, so the anchor renderer, and therefore every ordinary
 * link in a message, is left exactly as it was.
 */
import { defaultRemarkPlugins, Streamdown, type StreamdownProps } from "streamdown";

import { cn } from "@/lib/utils";

import { collapseMarkdownBlocks } from "./collapse-markdown-blocks";
import { InternalReference } from "./InternalReference";
import {
  REFERENCE_TAG,
  REFERENCE_TARGET_PROPERTY,
  remarkInternalReferences,
} from "./internal-references";
import { remarkLineBreaks } from "./remark-line-breaks";

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
  /**
   * Render every newline as a visible line break. For text where `\n` was a
   * deliberate keystroke — a sent user turn carries the composer's
   * Shift+Enter as exactly that — not for assistant markdown, which keeps
   * commonmark's soft-break-is-a-space.
   */
  breaks?: boolean;
  className?: string;
};

const SHIKI_THEME: NonNullable<StreamdownProps["shikiTheme"]> = ["github-light", "github-dark"];

const CONTROLS = { code: true, table: false, mermaid: false } as const;

/** Ours last, so gfm has already decided what is a link before we read the text. */
const REMARK_PLUGINS: NonNullable<StreamdownProps["remarkPlugins"]> = [
  ...Object.values(defaultRemarkPlugins),
  remarkInternalReferences,
];

/** Breaks after references, so a reference's own text is already settled. */
const REMARK_PLUGINS_WITH_BREAKS: NonNullable<StreamdownProps["remarkPlugins"]> = [
  ...REMARK_PLUGINS,
  remarkLineBreaks,
];

/**
 * The sanitizer keeps its own defaults and simply learns our tag. Widening its
 * `href` protocols instead would mean rebuilding the whole rehype chain, and it
 * would teach the sanitizer that `manuscript://` is a URL a browser may follow,
 * which it is not.
 */
const ALLOWED_TAGS = { [REFERENCE_TAG]: [REFERENCE_TARGET_PROPERTY] };

// react-markdown types `components` by HTML tag name, and this one is ours.
const COMPONENTS = { [REFERENCE_TAG]: InternalReference } as NonNullable<
  StreamdownProps["components"]
>;

/**
 * Thin Streamdown shell. Warm Organic element styling lives in `globals.css`
 * under `.prose-tokens` — not a full `components` override map.
 */
export function Markdown({ children, variant, mode = "static", breaks, className }: MarkdownProps) {
  const streaming = mode === "streaming";

  return (
    <Streamdown
      mode={mode}
      isAnimating={streaming}
      parseMarkdownIntoBlocksFn={streaming ? collapseMarkdownBlocks : undefined}
      shikiTheme={SHIKI_THEME}
      controls={CONTROLS}
      remarkPlugins={breaks ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS}
      allowedTags={ALLOWED_TAGS}
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
