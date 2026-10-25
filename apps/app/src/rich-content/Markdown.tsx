/** Canonical document rendering with app-owned static transcript presentation. */
import { cn } from "@/lib/utils";
import { DocumentMarkdown } from "./DocumentMarkdown";
import type { MarkdownReferenceOccurrence, MarkdownSkillOccurrence } from "./reference-occurrences";
import {
  TranscriptReferenceContext,
  type TranscriptReferenceResolution,
} from "./TranscriptReference";

type MarkdownBaseProps = {
  children: string;
  /** Dense meta voice for tool output and helper summaries. */
  variant?: "compact";
  className?: string;
  breaks?: boolean;
  references?: readonly MarkdownReferenceOccurrence[];
  skills?: readonly MarkdownSkillOccurrence[];
  referenceResolutions?: ReadonlyMap<string, TranscriptReferenceResolution>;
  onOpenReference?: (documentId: string) => void;
  /** A reference the host has no way to open is drawn without its link. */
  canOpenReference?: (uri: string) => boolean;
  uploadsChat?: string;
};

type MarkdownProps = MarkdownBaseProps &
  ({ mode: "streaming"; streamId: string } | { mode?: "static"; streamId?: string });

export function Markdown({
  children,
  variant,
  mode = "static",
  streamId,
  className,
  breaks = false,
  references,
  skills,
  referenceResolutions,
  onOpenReference,
  canOpenReference,
  uploadsChat,
}: MarkdownProps) {
  return (
    <TranscriptReferenceContext.Provider
      value={{
        resolutions: referenceResolutions,
        onOpen: onOpenReference,
        canOpen: canOpenReference,
        uploadsChat,
      }}
    >
      <DocumentMarkdown
        source={children}
        breaks={breaks}
        streaming={mode === "streaming"}
        streamId={streamId}
        references={references}
        skills={skills}
        className={cn(
          "prose-tokens document-prose document-prose--chat",
          variant === "compact" && "text-tier-compact",
          className,
        )}
      />
    </TranscriptReferenceContext.Provider>
  );
}
