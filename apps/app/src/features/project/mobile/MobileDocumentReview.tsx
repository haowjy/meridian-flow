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

import { type ReactNode, useEffect, useState } from "react";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import type { ContextTab } from "@/client/stores";
import { PaintCapture } from "@/components/app/PaintHold";
import { DiscardedRow } from "@/features/draft-review/DiscardedRow";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import type { ReviewChange } from "@/features/draft-review/review-model";
import { type ReviewHeaderModel, useReviewHeader } from "@/features/draft-review/useReviewHeader";
import { DocumentDraftHint } from "@/features/editor/DocumentDraftHint";
import { DraftReviewChip } from "@/features/editor/DraftReviewChip";
import { useAiDraftLauncher } from "../dock/useAiDraftLauncher";
import { MobileChangeBar } from "./MobileChangeBar";
import { MobileChangeSheet } from "./MobileChangeSheet";
import { MobileKeyboardAware } from "./MobileKeyboardAware";
import { MobileReviewHeader } from "./MobileReviewHeader";

export function MobileDocumentReview({
  projectId,
  tab,
  onCloseDraftOnly,
  children,
}: {
  projectId: string;
  tab: ContextTab;
  /** Set for a draft-only document: its review closes the document instead of returning to live. */
  onCloseDraftOnly?: () => void;
  children: ReactNode;
}) {
  const { documentId } = tab;
  const { controller } = useDraftReview();
  const review = controller.inlineReview;
  const itemKey = review?.documentId === documentId && review.shown ? review.itemKey : null;
  const { openReviewFile } = useAiDraftLauncher();
  const header = useReviewHeader({
    documentId,
    itemKey: itemKey ?? "",
    onCloseDraftOnly,
    onOpenDraft: (row: ReviewFileTarget) => openReviewFile(row, controller.workId),
  });
  const [listOpen, setListOpen] = useState(false);
  // The phone's review is read-only, so its one Discard is the last step of the "editor" surface's history.
  const [discarded, setDiscarded] = useState<ReviewChange | null>(null);
  useEffect(() => {
    if (!itemKey) {
      setListOpen(false);
      setDiscarded(null);
    }
  }, [itemKey]);

  return (
    <MobileKeyboardAware>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {itemKey ? (
          <ReviewTop header={header} onOpenList={() => setListOpen(true)} />
        ) : (
          <LiveDraftEntry documentId={documentId} />
        )}
        <DocumentDraftHint projectId={projectId} tab={tab} />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {itemKey ? (
          <ReviewBottom
            header={header}
            listOpen={listOpen}
            onListOpenChange={setListOpen}
            discarded={discarded}
            onDiscarded={setDiscarded}
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
  const { fileForDocument } = useDraftReview();
  const group = fileForDocument(documentId);
  if (!group) return null;
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

function ReviewTop({ header, onOpenList }: { header: ReviewHeaderModel; onOpenList: () => void }) {
  const { status } = header.view;
  return (
    <>
      <PaintCapture surface={status} state={status === "loading" ? "pending" : "painted"} />
      <MobileReviewHeader header={header} onOpenList={onOpenList} />
    </>
  );
}

function ReviewBottom({
  header,
  listOpen,
  onListOpenChange,
  discarded,
  onDiscarded,
}: {
  header: ReviewHeaderModel;
  listOpen: boolean;
  onListOpenChange: (open: boolean) => void;
  discarded: ReviewChange | null;
  onDiscarded: (change: ReviewChange | null) => void;
}) {
  const { view } = header;
  return (
    <>
      {discarded ? (
        <ul data-phone-discarded className="shrink-0 border-t border-border-subtle bg-background">
          <DiscardedRow
            touch
            entry={{ id: discarded.id, change: discarded, phase: "discarded" }}
            name=""
            onUndo={() => {
              view.undoLastDiscard();
              onDiscarded(null);
            }}
          />
        </ul>
      ) : null}
      <MobileChangeBar view={view} onDiscarded={onDiscarded} />
      <MobileChangeSheet open={listOpen} onOpenChange={onListOpenChange} view={view} />
    </>
  );
}
