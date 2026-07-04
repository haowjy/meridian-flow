/** DraftReviewCard — one-line docked bar for a chat's AI drafts. */
import { Trans } from "@lingui/react/macro";

import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import { cn } from "@/lib/utils";

import { DraftReviewLifecycleRow } from "./DraftReviewLifecycleRow";
import { useDraftReview } from "./DraftReviewProvider";
import { useAiDraftLauncher } from "./useAiDraftLauncher";

export type DraftReviewCardProps = {
  group: ThreadDraftGroup;
  /** Visual variant: anchored under an assistant turn, or docked above the
   *  composer (the unanchored fallback strip). Docked variant renders with
   *  no outer margin so the ChatView can stack it directly above Composer. */
  variant?: "inline" | "compact";
};

export function DraftReviewCard({ group, variant = "inline" }: DraftReviewCardProps) {
  const { controller, reviewableDraftsForGroup, nowMs } = useDraftReview();
  const { openAiDraft } = useAiDraftLauncher();
  const { visible: reviewableDrafts, active: activeDrafts } = reviewableDraftsForGroup(group);

  if (reviewableDrafts.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-1"
      data-draft-card
      data-document-id={group.documentId}
      data-variant={variant}
    >
      {reviewableDrafts.map((draft) => (
        <DraftReviewLifecycleRow
          key={draft.draftId}
          draft={draft}
          documentId={group.documentId}
          documentName={group.documentName}
          activeCount={activeDrafts.length}
          controller={controller}
          nowMs={nowMs}
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-md border border-border-subtle bg-card px-3 py-1.5 shadow-xs",
            variant === "inline" && "mt-3",
          )}
          activeMode="review-apply-discard"
          activeReviewLabel={<Trans>Review</Trans>}
          terminalCopy="changes"
          onReview={(draftId) => openAiDraft(group, draftId)}
        />
      ))}
    </div>
  );
}
