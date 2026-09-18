/**
 * Markdown renderer wrapper around Streamdown with Meridian's prose tokens.
 *
 * In `streaming` mode we deliberately keep Streamdown's own block splitting
 * (one block per lexer token) so its per-block `memo` can hold: only the last,
 * unstable block re-parses per token. Merging blocks back into one (as an older
 * helper did) forced a full-document reparse on every token. Paragraph spacing
 * parity with `static` mode comes from the container gap being zero, so the
 * `.prose-tokens` block margins are the only spacing in both modes.
 */

import { remarkWikiLink } from "@meridian/markup";
import { type ComponentType, useMemo } from "react";
import { defaultRemarkPlugins, Streamdown, type StreamdownProps } from "streamdown";

import { cn } from "@/lib/utils";

import {
  type MarkdownReferenceOccurrence,
  type MarkdownSkillOccurrence,
  REFERENCE_TAG,
  remarkReferenceOccurrences,
  SKILL_TAG,
} from "./reference-occurrences";
import { remarkLineBreaks } from "./remark-line-breaks";
import { TranscriptSkillToken } from "./SkillToken";
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
   *  - `streaming` → live frontier; Streamdown's per-block memo keeps stable
   *    blocks from re-parsing, so only the growing tail re-renders.
   *  - `static` → settled content; single markdown tree.
   */
  mode?: "streaming" | "static";
  className?: string;
  breaks?: boolean;
  references?: readonly MarkdownReferenceOccurrence[];
  skills?: readonly MarkdownSkillOccurrence[];
  referenceResolutions?: ReadonlyMap<string, TranscriptReferenceResolution>;
  onOpenReference?: (documentId: string) => void;
};

const SHIKI_THEME: NonNullable<StreamdownProps["shikiTheme"]> = ["github-light", "github-dark"];

const REFERENCE_COMPONENTS = {
  [REFERENCE_TAG]: TranscriptReference as ComponentType,
  [SKILL_TAG]: TranscriptSkillToken as ComponentType,
};
const EXACT_BLOCK = (source: string) => (source ? [source] : []);
const REFERENCE_REMEND = { links: false, images: false };

const CONTROLS = { code: true, table: false, mermaid: false } as const;

/**
 * Stable identity for the common "empty" case. A fresh `[]` default would
 * change every render and bust the memoized plugin/Streamdown props.
 */
const NO_REFERENCES: readonly MarkdownReferenceOccurrence[] = [];
const NO_SKILLS: readonly MarkdownSkillOccurrence[] = [];

const ALLOWED_TAGS = {
  [REFERENCE_TAG]: ["dataDocumentId", "dataUri", "dataTargetHref", "dataAuthoredLabel"],
  [SKILL_TAG]: ["dataSlug", "dataName", "dataDescription"],
};

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
  references = NO_REFERENCES,
  skills = NO_SKILLS,
  referenceResolutions,
  onOpenReference,
}: MarkdownProps) {
  const streaming = mode === "streaming";
  const exactSource = references.length > 0 || skills.length > 0;
  const remarkPlugins: NonNullable<StreamdownProps["remarkPlugins"]> = useMemo(
    () => [
      ...Object.values(defaultRemarkPlugins),
      remarkWikiLink,
      [remarkReferenceOccurrences, { occurrences: references, skills }],
      ...(breaks ? [remarkLineBreaks] : []),
    ],
    [breaks, references, skills],
  );

  return (
    <TranscriptReferenceContext.Provider
      value={{ resolutions: referenceResolutions, onOpen: onOpenReference }}
    >
      <Streamdown
        key={JSON.stringify({ references, skills })}
        mode={mode}
        isAnimating={streaming}
        parseMarkdownIntoBlocksFn={exactSource ? EXACT_BLOCK : undefined}
        parseIncompleteMarkdown={exactSource ? false : undefined}
        remend={REFERENCE_REMEND}
        shikiTheme={SHIKI_THEME}
        controls={CONTROLS}
        remarkPlugins={remarkPlugins}
        allowedTags={ALLOWED_TAGS}
        components={REFERENCE_COMPONENTS}
        className={cn(
          "prose-tokens",
          variant === "compact" && "text-tier-compact",
          // Zero gap: `.prose-tokens` block margins are the only vertical
          // rhythm, matching `static` mode's single-tree spacing exactly.
          streaming && "space-y-0",
          className,
        )}
      >
        {children}
      </Streamdown>
    </TranscriptReferenceContext.Provider>
  );
}
