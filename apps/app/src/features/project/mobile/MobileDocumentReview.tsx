/**
 * MobileDocumentReview — wraps a phone document's editor with the review's
 * chrome while that document is under inline review: the header above it, the
 * selected change's bar below it, the change-list sheet over it, the toast.
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
import { type ReactNode, useEffect, useState } from "react";

import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import type { DockRow } from "@/features/chat/docked-drafts";
import { ReviewToast } from "@/features/draft-review/ReviewToast";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";
import { useReviewHeader } from "@/features/draft-review/useReviewHeader";
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
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {draftId ? <ReviewBottom listOpen={listOpen} onListOpenChange={setListOpen} /> : null}
      </div>
    </MobileKeyboardAware>
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
  const { openDockRow } = useAiDraftLauncher();
  const header = useReviewHeader({
    documentId,
    draftId,
    onCloseDraftOnly,
    // The switcher lists this Work's drafts; each opens through the one launcher.
    onOpenDraft: (row: DockRow) => openDockRow(row, controller.workId),
  });
  return <MobileReviewHeader header={header} onOpenList={onOpenList} />;
}

function ReviewBottom({
  listOpen,
  onListOpenChange,
}: {
  listOpen: boolean;
  onListOpenChange: (open: boolean) => void;
}) {
  const { controller } = useDraftReview();
  const view = useReviewChanges(controller);
  const empty = view.items.length === 0;
  useEffect(() => {
    if (empty) onListOpenChange(false);
  }, [empty, onListOpenChange]);

  return (
    <>
      <MobileChangeBar view={view} />
      <MobileChangeSheet
        open={listOpen}
        onOpenChange={onListOpenChange}
        view={view}
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
