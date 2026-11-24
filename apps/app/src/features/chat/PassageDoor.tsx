import { t } from "@lingui/core/macro";
import { MIDDLE_BUTTON } from "@/core/editor/links";

import { contextUriFromWritePath } from "@/lib/context-uri";
import {
  type ContextPassageAnchor,
  useChatContextNavigation,
  useChatContextRoutability,
} from "./ChatContextNavigation";
import { documentDisplayName } from "./document-display-name";
import type { ExcerptSpan } from "./tool-result-preview";

export type PassageDoorProps = {
  path: string;
  excerpt: ExcerptSpan;
  passage?: ContextPassageAnchor;
};

export function PassageDoor({ path, excerpt, passage }: PassageDoorProps) {
  const openContextUri = useChatContextNavigation();
  const canOpenContextUri = useChatContextRoutability();

  const uri = contextUriFromWritePath(path);
  const isDoor =
    uri !== null &&
    passage !== undefined &&
    openContextUri !== null &&
    canOpenContextUri?.(uri) === true;

  const term = excerpt.match ? (
    <span
      className={
        isDoor
          ? "font-semibold text-foreground underline decoration-border decoration-1 underline-offset-[3px] transition-colors group-hover:decoration-jade-text group-hover:text-jade-text group-focus-visible:decoration-jade-text group-focus-visible:text-jade-text"
          : "font-semibold text-foreground"
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
    return <p className="text-xs leading-relaxed text-muted-foreground">{body}</p>;
  }

  return (
    <button
      type="button"
      aria-label={t`Open ${documentDisplayName(path)} at this passage. ${excerptText(excerpt)}`}
      onClick={(event) => {
        event.stopPropagation();
        openContextUri(uri, passage);
      }}
      onAuxClick={(event) => {
        if (event.button !== MIDDLE_BUTTON) return;
        event.stopPropagation();
        openContextUri(uri, passage);
      }}
      className="focus-ring group block w-full rounded-sm py-px text-left text-xs leading-relaxed text-muted-foreground"
    >
      {body}
    </button>
  );
}

function excerptText({ lead, match, trail, clipped }: ExcerptSpan): string {
  return `${clipped ? "…" : ""}${lead}${match}${trail}`;
}
