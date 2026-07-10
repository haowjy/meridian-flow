/**
 * DraftEntryBanner — in-editor strip shown when the live document has pending
 * AI changes and review is NOT open: the not-in-review counterpart to
 * DraftReviewHeader. Both render in EditorView's belowToolbar slot and the
 * mount host picks exactly one, so the strip reads as one surface in two
 * modes. The banner is the document-scoped nudge (the dock stays the
 * work-scoped aggregate); its Review pill routes through the same
 * openAiDraft entry as the dock rows. Non-dismissible by design: the changes
 * exist until the writer disposes of them, and a hidden banner would make a
 * dirty document look clean.
 */
import { Trans } from "@lingui/react/macro";

import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { useAiDraftLauncher } from "@/features/chat/useAiDraftLauncher";

export type DraftEntryBannerProps = {
  group: ThreadDraftGroup;
  /** The pending draft Review opens — resolved by the mount host via `pendingReviewDraft`. */
  draft: ThreadDraftListItem;
};

export function DraftEntryBanner({ group, draft }: DraftEntryBannerProps) {
  const { controller } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();

  return (
    <section
      className="surface-card flex min-w-0 shrink-0 items-center gap-3 border-border-subtle border-b px-4 py-2"
      data-draft-entry-banner
      role="status"
      aria-live="polite"
    >
      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 font-medium text-foreground text-sm">
        {/* Jade dot — the draft system's pending color (matches the dock),
            not the generic interactive accent the review header uses. */}
        <span aria-hidden className="size-2 rounded-full bg-jade-text" />
        <span className="truncate">
          <Trans>AI changes ready for review</Trans>
        </span>
      </span>
      <button
        type="button"
        onClick={() =>
          openAiDraft(
            {
              documentId: group.documentId,
              contextPath: group.contextPath ?? undefined,
              documentName: group.documentName ?? undefined,
              isNewDocument: draft.isNewDocument === true,
            },
            draft.draftId,
          )
        }
        disabled={controller.isDisposing}
        className="focus-ring ml-auto inline-flex h-5 shrink-0 items-center rounded-sm bg-primary px-2.5 font-semibold text-caption text-primary-foreground disabled:opacity-50"
      >
        <Trans>Review</Trans>
      </button>
    </section>
  );
}
