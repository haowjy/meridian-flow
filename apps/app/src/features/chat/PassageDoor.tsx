/**
 * PassageDoor — a matched passage rendered as the way into it.
 *
 * A sibling of `DocumentName`, and bound by the same rule: linkability and
 * navigation come from the *same* hooks the shell routes with, so a passage
 * can never look clickable and then do nothing. Outside a project shell both
 * are null and the excerpt degrades to what it always was, quoted prose.
 *
 * **The matched term is the handle, not the whole sentence.** Underlining a
 * full excerpt turns the writer's own prose into a link and buries the one
 * word they searched for. So the term carries the door's treatment — the same
 * weight it already had, plus the underline — while the whole row stays the
 * click target. One button, no nested control: the visible affordance is
 * smaller than the target, which is the point.
 *
 * **A passage with no anchor is not a door.** Non-manuscript schemes carry no
 * block hash, so their passages cannot be resolved; they render as prose and
 * the document's own name remains the way in. Promising a destination we
 * cannot reach is the failure the whole ladder exists to refuse.
 */
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

/**
 * The matched passage, with the searched words carrying the weight. No
 * coloured ground: this is the writer's prose, and a highlighter across it
 * would read as markup rather than as their sentence.
 */
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
