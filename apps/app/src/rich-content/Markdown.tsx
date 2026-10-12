/** Canonical document rendering; Streamdown temporarily owns source-authoritative tokens. */

import { type ComponentType, useMemo } from "react";
import { defaultRemarkPlugins, Streamdown, type StreamdownProps } from "streamdown";
import { cn } from "@/lib/utils";
import { DocumentMarkdown } from "./DocumentMarkdown";

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
   * Default inherits the surface reading scale (chat stays one tier below
   * the manuscript). `compact` is the dense meta voice for tool
   * output and helper summaries.
   */
  variant?: "compact";
  /**
   *  - `streaming` → live frontier; source-string block memo keeps stable
   *    blocks from re-parsing, so only the growing tail re-renders.
   *  - `static` → settled content; same document blocks without tail repair.
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

// Streamdown's default turns its "Open external link?" modal on. Off, web links open
// in a new tab like the Editor's.
const LINK_SAFETY: NonNullable<StreamdownProps["linkSafety"]> = { enabled: false };

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
 * Reference/skill turns retain their existing exact-source presentation during migration.
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
      [remarkReferenceOccurrences, { occurrences: references, skills }],
      ...(breaks ? [remarkLineBreaks] : []),
    ],
    [breaks, references, skills],
  );

  if (!exactSource) {
    return (
      <DocumentMarkdown
        source={children}
        breaks={breaks}
        streaming={streaming}
        className={cn(
          "prose-tokens document-prose document-prose--chat",
          variant === "compact" && "text-tier-compact",
          className,
        )}
      />
    );
  }

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
        linkSafety={LINK_SAFETY}
        remarkPlugins={remarkPlugins}
        allowedTags={ALLOWED_TAGS}
        components={REFERENCE_COMPONENTS}
        className={cn("prose-tokens", variant === "compact" && "text-tier-compact", className)}
      >
        {children}
      </Streamdown>
    </TranscriptReferenceContext.Provider>
  );
}
