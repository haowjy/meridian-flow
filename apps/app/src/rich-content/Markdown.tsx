/**
 * Markdown renderer wrapper around Streamdown with Meridian's prose tokens and streaming block collapse behavior.
 */

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
import { TranscriptReference, type TranscriptReferenceResolution } from "./TranscriptReference";

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
    ...(references.length ? [remarkReferenceOccurrences(references)] : []),
    ...(breaks ? [remarkLineBreaks] : []),
  ];
  const components = references.length
    ? {
        [REFERENCE_TAG]: ((props) => (
          <TranscriptReference
            {...props}
            resolutions={referenceResolutions}
            onOpen={onOpenReference}
          />
        )) as ComponentType,
      }
    : undefined;

  return (
    <Streamdown
      mode={mode}
      isAnimating={streaming}
      parseMarkdownIntoBlocksFn={streaming ? collapseMarkdownBlocks : undefined}
      shikiTheme={SHIKI_THEME}
      controls={CONTROLS}
      remarkPlugins={remarkPlugins}
      allowedTags={
        references.length ? { [REFERENCE_TAG]: ["dataDocumentId", "dataUri"] } : undefined
      }
      components={components}
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
