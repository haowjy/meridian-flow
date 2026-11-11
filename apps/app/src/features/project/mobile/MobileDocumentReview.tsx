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
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import type { OpenDocument } from "@/client/stores";
import { PaintCapture } from "@/components/app/PaintHold";
import { useDocumentNotice } from "@/features/draft-review/CommandNotice";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import type { DraftNotice } from "@/features/draft-review/draft-notices";
import { ReviewToast } from "@/features/draft-review/ReviewToast";
import { type ReviewHeaderModel, useReviewHeader } from "@/features/draft-review/useReviewHeader";
import {
  type ManuscriptState,
  ManuscriptStateSlot,
  useManuscriptState,
} from "@/features/editor/ManuscriptStateNotice";
import { useAiDraftLauncher } from "../review-launch";
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
  tab: OpenDocument;
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
    onOpenDraft: (row: ReviewFileTarget) => openReviewFile(row, controller.ownerKey),
  });
  const [listOpen, setListOpen] = useState(false);
  const manuscriptState = useManuscriptState(projectId, tab);
  const notice = useDocumentNotice(projectId, documentId);
  useEffect(() => {
    if (!itemKey) setListOpen(false);
  }, [itemKey]);

  return (
    <MobileKeyboardAware>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {itemKey ? (
          <ReviewTop
            projectId={projectId}
            tab={tab}
            header={header}
            manuscriptState={manuscriptState}
            notice={notice}
            onOpenList={() => setListOpen(true)}
          />
        ) : (
          <ManuscriptStateRow state={manuscriptState} notice={notice} />
        )}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {itemKey ? (
          <ReviewBottom header={header} listOpen={listOpen} onListOpenChange={setListOpen} />
        ) : null}
      </div>
    </MobileKeyboardAware>
  );
}

/**
 * What an Apply brought back, in a row of the review header's own height and inset, so the
 * line takes the header's place instead of pushing the page. The version chip is in the
 * toolbar row, as on a desktop.
 */
function ManuscriptStateRow({
  state,
  notice,
}: {
  state: ManuscriptState | null;
  notice: DraftNotice | null;
}) {
  if (!state && !notice) return null;
  return (
    <div
      className="flex min-h-12 shrink-0 items-center border-b border-border-subtle bg-review"
      style={{
        paddingLeft: "calc(0.25rem + env(safe-area-inset-left))",
        paddingRight: "calc(0.25rem + env(safe-area-inset-right))",
      }}
    >
      <ManuscriptStateSlot state={state} notice={notice} touch />
    </div>
  );
}

function ReviewTop({
  projectId,
  tab,
  header,
  manuscriptState,
  notice,
  onOpenList,
}: {
  projectId: string;
  tab: OpenDocument;
  header: ReviewHeaderModel;
  manuscriptState: ManuscriptState | null;
  notice: DraftNotice | null;
  onOpenList: () => void;
}) {
  const { status } = header.view;
  return (
    <>
      <PaintCapture surface={status} state={status === "loading" ? "pending" : "painted"} />
      <MobileReviewHeader
        projectId={projectId}
        tab={tab}
        header={header}
        manuscriptState={manuscriptState}
        notice={notice}
        onOpenList={onOpenList}
      />
    </>
  );
}

function ReviewBottom({
  header,
  listOpen,
  onListOpenChange,
}: {
  header: ReviewHeaderModel;
  listOpen: boolean;
  onListOpenChange: (open: boolean) => void;
}) {
  const { controller, view } = header;
  return (
    <>
      <MobileChangeBar view={view} canApply={header.canApply} />
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
