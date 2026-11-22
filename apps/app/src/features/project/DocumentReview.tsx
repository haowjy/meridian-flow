/**
 * One document host's review: its own controller, room owner and inline runtime, following what
 * that document paints. Every host that holds a document (main, the side, the phone)
 * gets one, so two documents on screen review two drafts without sharing state. Commands stay
 * account-wide and queued per item (`DraftCommandOwner`), so two hosts cannot interleave
 * commands on one item.
 *
 * Admission is the host's too: a closed draft is reconciled with the server, and a hidden one (a
 * Discard in flight) is refused, for this host's document alone.
 *
 * Only a host on screen reviews. The kept document's host and a closed side's host stay mounted
 * hidden: a host that is not showing paints nothing of a draft, admits nothing, holds no draft
 * room and writes no pin, so Discard's Undo lands in the editor the writer sees.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
import { useWorks } from "@/client/query/useWorks";
import type { OpenDocument } from "@/client/stores";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { useAccountId, useDraftCommandOwner } from "./context/account-feature-context";
import { useShellTreeVersion } from "./tree-version";
import {
  type ReviewAddressAdmission,
  type ReviewAdmissionPort,
  useReviewAdmission,
} from "./use-review-admission";
import { useWorkScopeState } from "./use-work-scope";
import { type DocumentPaint, useDocumentPaint } from "./views";

/** The review main's address names, and the route's verdict on it. Null off a document address. */
export type MainReviewAddress = {
  documentId: string | undefined;
  itemKey: string | undefined;
  admission: ReviewAddressAdmission | undefined;
};
export const MainReviewAddressContext = createContext<MainReviewAddress | null>(null);

export type DocumentReview = {
  value: DraftReviewContextValue;
  paint: DocumentPaint;
};

const DocumentPaintContext = createContext<DocumentPaint | null>(null);

/** The paint of the document whose host this is; null outside a document host. */
export function useHostDocumentPaint(): DocumentPaint | null {
  return useContext(DocumentPaintContext);
}

export function useDocumentReview(
  projectId: string,
  hostTab: OpenDocument | null,
  showing: boolean,
): DocumentReview {
  const tab = showing ? hostTab : null;
  const accountId = useAccountId();
  const paint = useDocumentPaint(projectId, tab);
  const documentId = tab?.documentId ?? null;
  const { workId: activeWorkId } = useWorkScopeState(projectId);
  const { works, noWork } = useWorks(projectId);
  const draftId = paint.draft?.draftId ?? paint.view.pin?.draftId ?? paint.scopeDraftId ?? "";
  // A lineage's drafts carry no Work: its review reads the scope's Work for archive state.
  const reviewWork =
    (draftId ? works?.find((work) => work.draftId === draftId) : undefined) ??
    (activeWorkId === noWork?.id
      ? noWork
      : (works?.find((work) => work.id === activeWorkId) ?? null));
  const showChanges = paint.view.showChanges;
  const marks = useMemo(
    () => ({
      visible: showChanges,
      set: (visible: boolean) => {
        if (documentId) setDocumentView(accountId, projectId, documentId, { showChanges: visible });
      },
    }),
    [accountId, projectId, documentId, showChanges],
  );
  // Live for the scope's draft is the toggle's Live (`shownDraft`); another owner's pin just goes.
  const shell = useShellTreeVersion();
  const scopeShown = paint.draft !== null && !paint.outOfScope;
  const showLive = useCallback(() => {
    if (documentId) setDocumentView(accountId, projectId, documentId, { version: "live" });
    if (scopeShown) shell?.show("live");
  }, [accountId, projectId, documentId, scopeShown, shell]);
  const value = useDraftReviewScopeValue({
    projectId,
    work: reviewWork,
    draftId,
    threadId: null,
    marks,
    showLive,
  });

  const draftCommands = useDraftCommandOwner();
  const queryClient = useQueryClient();
  const reviewedItemKey = paint.draft?.itemKey ?? "";
  const hidden = () => draftCommands.state(reviewedItemKey).hidden;
  // The end of a press that hid the item is a new port: admission retries what it refused (a
  // failed Discard leaves the draft pending).
  const itemHidden = useSyncExternalStore(draftCommands.subscribe, hidden, hidden);
  const enterInlineReview = value.controller.enterInlineReview;
  const port = useMemo<ReviewAdmissionPort>(
    () => ({
      write: (review) => {
        if (documentId) setDocumentView(accountId, projectId, documentId, { pin: review });
      },
      // A draft a press has in flight has already left its review; admitting it again would
      // re-open what the provider just closed, every render.
      admit: async (target) => {
        if (draftCommands.state(target.itemKey).hidden) return false;
        enterInlineReview(target.documentId, target.itemKey);
        return true;
      },
    }),
    [accountId, projectId, documentId, enterInlineReview, draftCommands, queryClient, itemHidden],
  );

  const main = useContext(MainReviewAddressContext);
  // An address naming this review is admitted by the route's answer; every other review is the
  // view's own.
  const admission: ReviewAddressAdmission =
    main?.itemKey && main.documentId === documentId && paint.draft?.itemKey === main.itemKey
      ? (main.admission ?? "pending")
      : "admitted";
  const presented = useMemo(
    () =>
      tab
        ? {
            documentId: tab.documentId,
            scheme: tab.kind === "new" ? null : tab.scheme,
            path: tab.kind === "new" ? null : tab.path,
            review: paint.draft,
            draftView: paint.view.version === "draft",
          }
        : null,
    [tab, paint.draft, paint.view.version],
  );
  useReviewAdmission({ review: value, presented, admission, port });
  return { value, paint };
}

/** Exposes one host's review to everything that host renders, in one or several subtrees. */
export function DocumentReviewBoundary({
  review,
  children,
}: {
  review: DocumentReview;
  children: ReactNode;
}) {
  return (
    <DraftReviewBoundary value={review.value}>
      <DocumentPaintContext.Provider value={review.paint}>{children}</DocumentPaintContext.Provider>
    </DraftReviewBoundary>
  );
}

/** A document host's own review, for a host whose chrome and body share one subtree. */
export function DocumentReviewProvider({
  projectId,
  document,
  showing,
  children,
}: {
  projectId: string;
  document: OpenDocument | null;
  /** Whether the host is on screen; one that is not reviews nothing. */
  showing: boolean;
  children: ReactNode;
}) {
  const review = useDocumentReview(projectId, document, showing);
  return <DocumentReviewBoundary review={review}>{children}</DocumentReviewBoundary>;
}
