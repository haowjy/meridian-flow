/** Renders transcript document names and their navigation affordance. */
import { t } from "@lingui/core/macro";
import { MIDDLE_BUTTON } from "@/core/editor/links";
import {
  canOpenReference,
  useProjectDocumentNavigationProjectId,
} from "@/features/project/context/open-project-document";
import { useOpenPlacedDocument } from "@/features/project/review-launch";
import { contextUriFromWritePath } from "@/lib/context-uri";
import { useChatContextNavigation, useChatContextRoutability } from "./ChatContextNavigation";
import { documentDisplayName } from "./document-display-name";

export type DocumentNameProps = {
  /** A context URI or a bare write path (`chapter.md`), normalized before routing. */
  path: string;
  insideDoor?: boolean;
  /** `name` reads as prose mid-sentence ("Read ⟨Chapter 3⟩"). */
  label?: "name" | "open";
  /** The words in place of the document's own name, such as a move's qualified destination. */
  name?: string;
  /**
   * The file's identity, for one the result names exactly: a binary has no address a route
   * follows, but its document opens like a mention in a message does. An upload has no door.
   */
  documentId?: string;
};

export function DocumentName({
  path,
  insideDoor = false,
  label = "name",
  name: shownName,
  documentId,
}: DocumentNameProps) {
  const projectId = useProjectDocumentNavigationProjectId();
  const openPlaced = useOpenPlacedDocument(projectId ?? undefined);
  const openContextUri = useChatContextNavigation();
  const canOpenContextUri = useChatContextRoutability();
  const title = shownName ?? documentDisplayName(path);

  // Bare paths (`chapter.md`) are what `write` input carries most of the time;
  // the route predicate requires a scheme, so normalize before asking.
  const uri = contextUriFromWritePath(path);
  const byIdentity = documentId !== undefined && projectId !== null && canOpenReference(path);
  const isDoor =
    byIdentity ||
    (uri !== null && !insideDoor && openContextUri !== null && canOpenContextUri?.(uri) === true);
  const open = () => {
    if (byIdentity) void openPlaced(documentId);
    else if (uri !== null) openContextUri?.(uri, undefined);
  };

  const openLabel = t`Open ${title}`;
  // The inner span carries the truncation so the door's padding, which grows
  // its touch target past the line box, is never clipped by an ancestor.
  const name = <span className="min-w-0 truncate">{label === "open" ? openLabel : title}</span>;

  if (!isDoor) {
    return <span className="flex min-w-0 items-baseline text-foreground">{name}</span>;
  }

  return (
    <button
      type="button"
      aria-label={openLabel}
      // The row behind this name is the expand toggle; navigating must not also
      // fold the row open.
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
      onAuxClick={(event) => {
        if (event.button !== MIDDLE_BUTTON) return;
        event.stopPropagation();
        open();
      }}
      // `-my-2 py-[var(--chat-card-pad-y)]` grows the touch target to ~37px without changing row
      // rhythm. The overflow lands inside the row's own 8px bottom padding, so
      // it never covers a neighbouring row's title or expand contents — and no
      // ancestor may clip it, which is why truncation lives on the inner span.
      className="focus-ring relative z-10 -my-2 flex min-w-0 items-baseline rounded-sm py-[var(--chat-space-block)] text-left text-muted-foreground underline decoration-border decoration-1 underline-offset-[3px] transition-colors hover:text-jade-text hover:decoration-jade-text focus-visible:text-jade-text focus-visible:decoration-jade-text"
    >
      {name}
    </button>
  );
}
