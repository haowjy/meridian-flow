/**
 * DocumentName — the one component that renders a writer-facing document name
 * in the transcript, and therefore the one place that decides whether that name
 * is a door.
 *
 * **Names are doors.** Every document name in the activity timeline opens that
 * document. Folders, patterns, skills and chrome are not documents and never
 * render through here. Because a single component owns the rule, "names are
 * doors" is a function rather than a convention every renderer has to uphold.
 *
 * Linkability and navigation come from the *same* predicate the shell uses to
 * route (`useChatContextRoutability` / `useChatContextNavigation`), so a name
 * can never look clickable and then do nothing. Outside a project shell both
 * hooks return `null` and every name degrades to plain text with no per-caller
 * knowledge of that fact.
 *
 * **One door, two precisions.** A name that stands for a whole document opens
 * the document; a name that stands for a matched passage carries that passage
 * with it and opens there. The affordance is identical either way — the
 * promise is a destination, and the destination is as precise as the row that
 * offered it.
 *
 * **Tone and decoration move together.** A muted name reads as *quiet* only
 * while the underline holds it up; muted with no decoration reads as a disabled
 * control. So a door is muted + underlined, and a plain name is prose-toned +
 * undecorated. Never muted and undecorated.
 *
 * **A door never checks whether its document still exists.** Pre-checking
 * against the cached context tree would make the same row clickable or not
 * depending on cache warmth, and absence is unprovable from a cold cache. The
 * promise is the URI the agent used, nothing more; the destination explains a
 * document that has gone (`context-pane-state.ts`, `dead-route`).
 */
import { t } from "@lingui/core/macro";

import { contextUriFromWritePath } from "@/lib/context-uri";
import {
  type ContextPassageAnchor,
  useChatContextNavigation,
  useChatContextRoutability,
} from "./ChatContextNavigation";
import { documentDisplayName } from "./document-display-name";

export type DocumentNameProps = {
  /** A context URI or a bare write path (`chapter.md`), normalized before routing. */
  path: string;
  /**
   * Set when an ancestor is already the door for this name (the turn-edits
   * receipt renders full-width document rows). A door inside a door would be
   * invalid HTML and a second, competing tab stop.
   */
  insideDoor?: boolean;
  /**
   * `name` reads as prose mid-sentence ("Read ⟨Chapter 3⟩"). `open` names the
   * action, for a door that stands alone with no verb in front of it — the one
   * under a clipped preview, where the writer has read to the bound. Never
   * "Show more": more promises more of the same finite payload, and the
   * document is a larger and different thing.
   */
  label?: "name" | "open";
  /**
   * Set by a name that stands for a particular passage rather than the whole
   * document — a search match. The door then means "show me this passage",
   * and the destination degrades to the document when the passage has moved on.
   */
  passage?: ContextPassageAnchor;
};

export function DocumentName({
  path,
  insideDoor = false,
  label = "name",
  passage,
}: DocumentNameProps) {
  const openContextUri = useChatContextNavigation();
  const canOpenContextUri = useChatContextRoutability();
  const title = documentDisplayName(path);

  // Bare paths (`chapter.md`) are what `write` input carries most of the time;
  // the route predicate requires a scheme, so normalize before asking.
  const uri = contextUriFromWritePath(path);
  const isDoor = !insideDoor && openContextUri !== null && canOpenContextUri?.(uri) === true;

  const openLabel = t`Open ${title}`;
  // The inner span carries the truncation so the door's padding, which grows
  // its touch target past the line box, is never clipped by an ancestor.
  const name = <span className="min-w-0 truncate">{label === "open" ? openLabel : title}</span>;

  if (!isDoor) {
    return <span className="flex min-w-0 items-baseline text-prose-foreground">{name}</span>;
  }

  return (
    <button
      type="button"
      aria-label={openLabel}
      // The row behind this name is the expand toggle; navigating must not also
      // fold the row open.
      onClick={(event) => {
        event.stopPropagation();
        openContextUri(uri, passage);
      }}
      // `-my-2 py-2` grows the touch target to ~37px without changing row
      // rhythm. The overflow lands inside the row's own 8px bottom padding, so
      // it never covers a neighbouring row's title or expand contents — and no
      // ancestor may clip it, which is why truncation lives on the inner span.
      className="focus-ring relative z-10 -my-2 flex min-w-0 items-baseline rounded-sm py-2 text-left text-muted-foreground underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-jade-text hover:decoration-jade-text focus-visible:text-jade-text focus-visible:decoration-jade-text"
    >
      {name}
    </button>
  );
}
