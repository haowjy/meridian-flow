/**
 * MobileDocumentReview — wraps a phone document's editor with the review's
 * chrome while that document is under inline review: the header above it, the
 * selected change's bar below it, this document's change-list sheet over it,
 * the toast.
 * With no review of this document it is only the column the editor sits in.
 *
 * Every command goes through the same controller the desktop uses
 * (`useReviewHeader`, `useReviewChanges`), so optimistic Apply and Discard,
 * refusals, toasts, the entry hold and "No changes left" behave alike on both.
 * The header and bar appear with the painted review (`inlineReview.shown`),
 * never over the live text that is held until then.
 *
 * The editor keeps one place in this tree whether or not a review is open, so
 * entering and leaving review never remounts it.
 */
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { pendingReviewDraft } from "@/client/query/useWorkDrafts";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { ReviewToast } from "@/features/draft-review/ReviewToast";
import {
  nextReviewFile,
  type ReviewFileTarget,
  reviewFileTargets,
} from "@/features/draft-review/review-files";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";
import { useReviewHeader } from "@/features/draft-review/useReviewHeader";
import { DraftReviewChip } from "@/features/editor/DraftReviewChip";
import { useAiDraftLauncher } from "../dock/useAiDraftLauncher";
import { MobileChangeBar } from "./MobileChangeBar";
import { MobileChangeSheet } from "./MobileChangeSheet";
import { MobileKeyboardAware } from "./MobileKeyboardAware";
import { MobileReviewHeader } from "./MobileReviewHeader";

export function MobileDocumentReview({
  documentId,
  onCloseDraftOnly,
  children,
}: {
  documentId: string;
  /** Set for a draft-only document: its review closes the document instead of returning to live. */
  onCloseDraftOnly?: () => void;
  children: ReactNode;
}) {
  const { controller } = useDraftReview();
  const review = controller.inlineReview;
  const draftId = review?.documentId === documentId && review.shown ? review.draftId : null;
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    if (!draftId) setListOpen(false);
  }, [draftId]);

  return (
    <MobileKeyboardAware>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {draftId ? (
          <ReviewTop
            documentId={documentId}
            draftId={draftId}
            onCloseDraftOnly={onCloseDraftOnly}
            onOpenList={() => setListOpen(true)}
          />
        ) : (
          <LiveDraftEntry documentId={documentId} />
        )}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {draftId ? (
          <ReviewBottom
            documentId={documentId}
            listOpen={listOpen}
            onListOpenChange={setListOpen}
          />
        ) : null}
      </div>
    </MobileKeyboardAware>
  );
}

/**
 * The live document's way into its pending draft: the Draft chip in a row of
 * the review header's own height and inset, so the chip stays where the
 * reviewing one will be. Nothing is drawn for a document with no pending draft.
 */
function LiveDraftEntry({ documentId }: { documentId: string }) {
  const { groupForDocument } = useDraftReview();
  const group = groupForDocument(documentId);
  if (!group || !pendingReviewDraft(group)) return null;
  return (
    <div
      data-phone-draft-entry
      className="flex min-h-12 shrink-0 items-center border-b border-border-subtle bg-dock-surface"
      style={{
        paddingLeft: "calc(0.25rem + env(safe-area-inset-left))",
        paddingRight: "calc(0.25rem + env(safe-area-inset-right))",
      }}
    >
      <DraftReviewChip documentId={documentId} touch />
    </div>
  );
}

function ReviewTop({
  documentId,
  draftId,
  onCloseDraftOnly,
  onOpenList,
}: {
  documentId: string;
  draftId: string;
  onCloseDraftOnly?: () => void;
  onOpenList: () => void;
}) {
  const { controller } = useDraftReview();
  const { openReviewFile } = useAiDraftLauncher();
  const header = useReviewHeader({
    documentId,
    draftId,
    onCloseDraftOnly,
    // The switcher lists this Work's drafts; each opens through the one launcher.
    onOpenDraft: (row: ReviewFileTarget) => openReviewFile(row, controller.workId),
  });
  return <MobileReviewHeader header={header} onOpenList={onOpenList} />;
}

function ReviewBottom({
  documentId,
  listOpen,
  onListOpenChange,
}: {
  documentId: string;
  listOpen: boolean;
  onListOpenChange: (open: boolean) => void;
}) {
  const { controller, groups } = useDraftReview();
  const { openReviewFile } = useAiDraftLauncher();
  const view = useReviewChanges(controller);
  const rows = useMemo(() => reviewFileTargets(groups), [groups]);

  return (
    <>
      <MobileChangeBar view={view} />
      <MobileChangeSheet
        open={listOpen}
        onOpenChange={onListOpenChange}
        view={view}
        next={nextReviewFile(
          rows,
          documentId,
          controller.inlineReview?.completion?.documentName ?? null,
        )}
        onOpenNext={(row) => openReviewFile(row, controller.workId)}
        controller={controller}
      />
      <ReviewToast
        toast={listOpen ? null : controller.toast}
        onDismiss={controller.dismissToast}
        className={
          view.focused
            ? "bottom-[calc(max(0.5rem,env(safe-area-inset-bottom),var(--mobile-keyboard-height,0px))+5.25rem)]"
            : "bottom-4"
        }
      />
    </>
  );
}
