/** Renders transcript document names and their navigation affordance. */
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
  insideDoor?: boolean;
  /** `name` reads as prose mid-sentence ("Read ⟨Chapter 3⟩"). */
  label?: "name" | "open";
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
