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
import type { DiscardSubject, ReviewFileTarget } from "@/client/query/work-draft-files";
import type { ContextTab } from "@/client/stores";
import { PaintCapture } from "@/components/app/PaintHold";
import { DiscardedRow } from "@/features/draft-review/DiscardedRow";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import {
  type HeadlessDiscards,
  useHeadlessDiscards,
} from "@/features/draft-review/useHeadlessDiscards";
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
  // The phone's review is read-only: a Discard is a headless edit of the draft's room with its own Undo,
  // scoped to this document's open review so its rows end with it.
  const { reviewRoomNameForDraft } = useDraftReview();
  const discards = useHeadlessDiscards(
    projectId,
    controller.workId,
    `${documentId}:${itemKey ?? ""}`,
  );
  const roomName = itemKey ? reviewRoomNameForDraft(documentId, itemKey) : null;
  // The open review names what a Discard acts on, so a draft the Work list no longer carries (its last
  // change was just discarded) still has its Undo.
  const subject = useMemo<DiscardSubject | null>(
    () =>
      itemKey
        ? { documentId, itemKey, documentName: tab.name, contextLocation: null, isNew: false }
        : null,
    [documentId, itemKey, tab.name],
  );
  const header = useReviewHeader({
    documentId,
    itemKey: itemKey ?? "",
    headless: subject && roomName ? { discards, subject, roomName } : undefined,
    onCloseDraftOnly,
    onOpenDraft: (row: ReviewFileTarget) => openReviewFile(row, controller.workId),
  });
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    if (!itemKey) setListOpen(false);
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
            discards={discards}
            itemKey={itemKey}
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
  discards,
  itemKey,
}: {
  header: ReviewHeaderModel;
  listOpen: boolean;
  onListOpenChange: (open: boolean) => void;
  discards: HeadlessDiscards;
  itemKey: string;
}) {
  const { view } = header;
  const rows = discards.entries.filter((entry) => entry.subject.itemKey === itemKey);
  return (
    <>
      {rows.length > 0 ? (
        <ul data-phone-discarded className="shrink-0 border-t border-border-subtle bg-background">
          {rows.map((entry) => (
            <DiscardedRow
              key={entry.id}
              touch
              entry={entry}
              name={entry.subject.documentName ?? ""}
              onUndo={() => discards.undo(entry.id)}
            />
          ))}
        </ul>
      ) : null}
      <MobileChangeBar view={view} />
      <MobileChangeSheet open={listOpen} onOpenChange={onListOpenChange} view={view} />
    </>
  );
}
