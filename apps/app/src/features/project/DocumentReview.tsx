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
import { workIdOfDraftOwnerKey } from "@meridian/contracts/branches";
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
import { fetchCurrentDraftMetadata } from "@/client/query/useDraftMetadata";
import { useWorks } from "@/client/query/useWorks";
import type { OpenDocument } from "@/client/stores";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { useAccountId, useDraftCommandOwner } from "./context/account-feature-context";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import {
  type ReviewAddressAdmission,
  type ReviewAdmissionPort,
  useReviewAdmission,
} from "./use-review-admission";
import { type DocumentPaint, useDocumentPaint } from "./views";

/** The review main's address names, and the route's verdict on it. Null off a document address. */
export type MainReviewAddress = {
  documentId: string | undefined;
  itemKey: string | undefined;
  admission: ReviewAddressAdmission | undefined;
};
export const MainReviewAddressContext = createContext<MainReviewAddress | null>(null);

export type DocumentReview = { value: DraftReviewContextValue; paint: DocumentPaint };

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
  const { activeWorkId } = useContextRemovalProject(projectId);
  const { works, noWork } = useWorks(projectId);
  const ownerKey = paint.draft?.ownerKey ?? paint.view.pin?.ownerKey ?? paint.scopeOwnerKey ?? "";
  // A lineage's drafts carry no Work: its review reads the scope's Work for archive state.
  const reviewWorkId = workIdOfDraftOwnerKey(ownerKey) ?? activeWorkId;
  const reviewWork =
    reviewWorkId === noWork?.id
      ? noWork
      : (works?.find((work) => work.id === reviewWorkId) ?? null);
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
  const showLive = useCallback(() => {
    if (documentId) setDocumentView(accountId, projectId, documentId, { version: "live" });
  }, [accountId, projectId, documentId]);
  const value = useDraftReviewScopeValue({
    projectId,
    work: reviewWork,
    ownerKey,
    threadId: null,
    marks,
    showLive,
  });

  const draftCommands = useDraftCommandOwner();
  const queryClient = useQueryClient();
  const reviewedItemKey = paint.draft?.itemKey ?? "";
  const generation = () => draftCommands.generation(reviewedItemKey);
  const hidden = () => draftCommands.state(reviewedItemKey).hidden;
  // A new generation of the item is a new port: admission retries what it refused. So is the
  // end of a command that hid it: a refused Discard leaves the draft pending.
  const itemGeneration = useSyncExternalStore(draftCommands.subscribe, generation, generation);
  const itemHidden = useSyncExternalStore(draftCommands.subscribe, hidden, hidden);
  const enterInlineReview = value.controller.enterInlineReview;
  const port = useMemo<ReviewAdmissionPort>(
    () => ({
      write: (review) => {
        if (documentId) setDocumentView(accountId, projectId, documentId, { pin: review });
      },
      // A hidden draft (a Discard in flight) or a closed one (Discard, here or on another
      // device) has already ended its review: the room owner exits it. A draft-only document
      // keeps naming it until settlement closes its tab, and admitting it again would re-open
      // what the room owner just closed, every render. The view names an item, not a draft:
      // the server decides whether a newer draft replaced the closed one.
      admit: async (target) => {
        if (draftCommands.state(target.itemKey).hidden) return false;
        if (draftCommands.state(target.itemKey).closed) {
          const ref = {
            projectId,
            ownerKey: target.ownerKey,
            documentId: target.documentId,
            itemKey: target.itemKey,
          };
          const current = await draftCommands.reconcileClosed(ref, () =>
            fetchCurrentDraftMetadata(queryClient, ref),
          );
          if (!current) return false;
        }
        enterInlineReview(target.documentId, target.itemKey);
        return true;
      },
    }),
    [
      accountId,
      projectId,
      documentId,
      enterInlineReview,
      draftCommands,
      queryClient,
      itemGeneration,
      itemHidden,
    ],
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
  tab,
  showing,
  children,
}: {
  projectId: string;
  tab: OpenDocument | null;
  /** Whether the host is on screen; one that is not reviews nothing. */
  showing: boolean;
  children: ReactNode;
}) {
  const review = useDocumentReview(projectId, tab, showing);
  return <DocumentReviewBoundary review={review}>{children}</DocumentReviewBoundary>;
}
