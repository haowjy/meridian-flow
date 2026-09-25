/** PassageDoor — a matched passage rendered as the way into it. */
import { t } from "@lingui/core/macro";

import { contextUriFromWritePath } from "@/lib/context-uri";
import {
  type ContextPassageAnchor,
  useChatContextNavigation,
  useChatContextRoutability,
} from "./ChatContextNavigation";
import { documentDisplayName } from "./document-display-name";
import type { ExcerptSpan } from "./tool-result-preview";

export type PassageDoorProps = {
  /** The document this passage lives in. */
  path: string;
  excerpt: ExcerptSpan;
  /** Absent when the passage cannot be resolved; the row then renders as prose. */
  passage?: ContextPassageAnchor;
};

export function PassageDoor({ path, excerpt, passage }: PassageDoorProps) {
  const openContextUri = useChatContextNavigation();
  const canOpenContextUri = useChatContextRoutability();

  const uri = contextUriFromWritePath(path);
  const isDoor =
    passage !== undefined && openContextUri !== null && canOpenContextUri?.(uri) === true;

  const term = excerpt.match ? (
    <span
      className={
        isDoor
          ? "font-semibold text-prose-foreground underline decoration-border decoration-1 underline-offset-[3px] transition-colors group-hover:decoration-jade-text group-hover:text-jade-text group-focus-visible:decoration-jade-text group-focus-visible:text-jade-text"
          : "font-semibold text-prose-foreground"
      }
    >
      {excerpt.match}
    </span>
  ) : null;

  const body = (
    <>
      {excerpt.clipped ? "…" : null}
      {excerpt.lead}
      {term}
      {excerpt.trail}
    </>
  );

  if (!isDoor) {
    return <p className="text-xs leading-relaxed text-ink-muted">{body}</p>;
  }

  return (
    <button
      type="button"
      // The destination first, then the passage itself: a label that named only
      // the document would leave a screen reader with four identical doors.
      aria-label={t`Open ${documentDisplayName(path)} at this passage. ${excerptText(excerpt)}`}
      onClick={(event) => {
        // The row behind this expand is the toggle; opening must not fold it.
        event.stopPropagation();
        openContextUri(uri, passage);
      }}
      className="focus-ring group block w-full rounded-sm py-px text-left text-xs leading-relaxed text-ink-muted"
    >
      {body}
    </button>
  );
}

/** The excerpt as one string, for the label a screen reader reads. */
function excerptText({ lead, match, trail, clipped }: ExcerptSpan): string {
  return `${clipped ? "…" : ""}${lead}${match}${trail}`;
}
