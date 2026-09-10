/**
 * Markdown renderer wrapper around Streamdown with Meridian's prose tokens and streaming block collapse behavior.
 */

import { remarkWikiLink } from "@meridian/markup";
import type { ComponentType } from "react";
import { defaultRemarkPlugins, Streamdown, type StreamdownProps } from "streamdown";

import { cn } from "@/lib/utils";

import { collapseMarkdownBlocks } from "./collapse-markdown-blocks";
import {
  type MarkdownReferenceOccurrence,
  REFERENCE_TAG,
  remarkReferenceOccurrences,
} from "./reference-occurrences";
import { remarkLineBreaks } from "./remark-line-breaks";
import {
  TranscriptReference,
  TranscriptReferenceContext,
  type TranscriptReferenceResolution,
} from "./TranscriptReference";

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
  breaks?: boolean;
  references?: readonly MarkdownReferenceOccurrence[];
  referenceResolutions?: ReadonlyMap<string, TranscriptReferenceResolution>;
  onOpenReference?: (documentId: string) => void;
};

const SHIKI_THEME: NonNullable<StreamdownProps["shikiTheme"]> = ["github-light", "github-dark"];

const REFERENCE_COMPONENTS = { [REFERENCE_TAG]: TranscriptReference as ComponentType };
const EXACT_BLOCK = (source: string) => (source ? [source] : []);
const REFERENCE_REMEND = { links: false, images: false };

const CONTROLS = { code: true, table: false, mermaid: false } as const;

/**
 * Thin Streamdown shell. Warm Organic element styling lives in `globals.css`
 * under `.prose-tokens` — not a full `components` override map.
 */
export function Markdown({
  children,
  variant,
  mode = "static",
  className,
  breaks = false,
  references = [],
  referenceResolutions,
  onOpenReference,
}: MarkdownProps) {
  const streaming = mode === "streaming";
  const remarkPlugins: NonNullable<StreamdownProps["remarkPlugins"]> = [
    ...Object.values(defaultRemarkPlugins),
    remarkWikiLink,
    [remarkReferenceOccurrences, { occurrences: references }],
    ...(breaks ? [remarkLineBreaks] : []),
  ];

  return (
    <TranscriptReferenceContext.Provider
      value={{ resolutions: referenceResolutions, onOpen: onOpenReference }}
    >
      <Streamdown
        key={JSON.stringify(references)}
        mode={mode}
        isAnimating={streaming}
        parseMarkdownIntoBlocksFn={
          references.length ? EXACT_BLOCK : streaming ? collapseMarkdownBlocks : undefined
        }
        parseIncompleteMarkdown={references.length ? false : undefined}
        remend={REFERENCE_REMEND}
        shikiTheme={SHIKI_THEME}
        controls={CONTROLS}
        remarkPlugins={remarkPlugins}
        allowedTags={{
          [REFERENCE_TAG]: ["dataDocumentId", "dataUri", "dataTargetHref", "dataAuthoredLabel"],
        }}
        components={REFERENCE_COMPONENTS}
        className={cn(
          "prose-tokens",
          variant === "compact" && "text-tier-compact",
          streaming && "space-y-2",
          className,
        )}
      >
        {children}
      </Streamdown>
    </TranscriptReferenceContext.Provider>
  );
}
