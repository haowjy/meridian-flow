/**
 * The one review-launch path. Every launcher (the composer strip, a change card, a link to a draft,
 * the Work page, the version menu, the phone) calls `openAiDraft`: it sets the document's view to
 * that draft, with the clicked change as the pin's change, and opens the document in the pane
 * `useHoldBeside` picks. In main, the route command opens it and writes the address; beside, the
 * hold shows it. That pane's host then paints the draft and focuses the change. Latest launch wins.
 */

import type { EventRecord } from "@meridian/contracts/observability";
import { createContext, type ReactNode, useCallback, useContext, useRef } from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import type { LinkFollowDisposition } from "@/core/editor/links";
import { useOptionalChatPlace } from "@/features/chat/chat-place";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";
import type { ReviewFocus } from "@/features/draft-review/review-model";
import type { LinkDocumentRef } from "@/features/links";
import type { ContextUri } from "@/lib/context-uri";
import { useAccountId } from "./context/account-feature-context";
import { openDocumentFromDraftGroup } from "./context/open-document-from-draft";
import type { OpenDocumentOutcome } from "./context/open-project-document";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";
import { contextRouteRequest } from "./routing/project-route";
import { useOptionalShowBeside } from "./side/SideView";

type ShowBeside = NonNullable<ReturnType<typeof useOptionalShowBeside>>;

export type AiDraftLaunchTarget = {
  ownerKey: string;
  documentId: string;
  itemKey: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
  documentName?: string;
  /** Live doesn't hold the document: the draft created it, or live deleted it. */
  draftOnly?: boolean;
  /** A projection-local change to focus, only if that projection still paints. */
  focus?: ReviewFocus;
};

type EditorReviewCommand = (target: AiDraftLaunchTarget) => Promise<void>;

function reportRouteSettlement(
  projectId: string,
  target: AiDraftLaunchTarget,
  kind: "applied" | "cancelled" | "superseded" | "failed",
  attempt: number,
): void {
  if (!DEBUG_FEATURE_ALLOWED) return;
  const event: EventRecord = {
    timestamp: new Date().toISOString(),
    level: kind === "failed" ? "error" : kind === "applied" ? "info" : "warn",
    source: "project.review",
    name: "editor_review.route_settlement",
    sensitivity: "safe",
    correlation: { projectId },
    payload: {
      kind,
      attempt,
      ownerKey: target.ownerKey,
      documentId: target.documentId,
      itemKey: target.itemKey,
    },
  };
  appendTraceEvent(event);
}

const EditorReviewCommandContext = createContext<EditorReviewCommand | null>(null);

export function ReviewLaunchProvider({
  projectId,
  openContextRoute,
  children,
}: {
  projectId: string;
  openContextRoute: OpenContextRoute;
  children: ReactNode;
}) {
  const accountId = useAccountId();
  const sequence = useRef(0);
  const openEditorReview = useCallback<EditorReviewCommand>(
    async (target) => {
      // The pin is written once the document is open, so a cancelled or failed navigation leaves
      // no other host holding this document switched to the draft.
      const pin = () =>
        setDocumentView(accountId, projectId, target.documentId, {
          pin: {
            ownerKey: target.ownerKey,
            itemKey: target.itemKey,
            ...(target.focus ? { changeId: target.focus.id } : {}),
          },
        });
      const tab = openDocumentFromDraftGroup(target);
      const launch = ++sequence.current;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await openContextRoute(
          contextRouteRequest({
            ...target.contextLocation,
            documentId: target.documentId,
          }),
          {
            replaceIfSameDocument: true,
            document: tab ?? undefined,
            draftOnly: target.draftOnly,
            itemKey: target.itemKey,
            reviewOwner: target.ownerKey,
            changeId: target.focus?.id,
            canCommit: () => sequence.current === launch,
            afterCommit: pin,
          },
        );
        reportRouteSettlement(projectId, target, result.kind, attempt + 1);
        if (result.kind === "failed") throw result.error;
        if (result.kind !== "superseded" || sequence.current !== launch) return;
      }
      throw new Error("Editor review navigation did not settle after retry");
    },
    [openContextRoute, projectId, accountId],
  );

  return (
    <EditorReviewCommandContext.Provider value={openEditorReview}>
      {children}
    </EditorReviewCommandContext.Provider>
  );
}

/** Null where no review owner is mounted: a surface that only sometimes launches a review (a link to a draft). */
function useOptionalOpenEditorReview(): EditorReviewCommand | null {
  return useContext(EditorReviewCommandContext);
}

/**
 * Where an open goes. From a chat in main, a page is held beside, whatever the gesture; the chat
 * stays where it is. From a chat beside, or anywhere else (a document never sits beside a
 * document), it opens in main, whatever the gesture. Null opens in main.
 */
function useHoldBeside(): ShowBeside | null {
  const chatInMain = useOptionalChatPlace() === "main";
  const hold = useOptionalShowBeside();
  return chatInMain ? hold : null;
}

const committed = (documentId: string): OpenDocumentOutcome => ({ kind: "committed", documentId });

/** Opens a document on a draft, in the pane `useHoldBeside` picks. */
function useOpenDraft(): (target: AiDraftLaunchTarget) => Promise<OpenDocumentOutcome> {
  const openEditorReview = useOptionalOpenEditorReview();
  const hold = useHoldBeside();
  return useCallback(
    (target) => {
      if (hold) {
        hold(
          { documentId: target.documentId },
          {
            ownerKey: target.ownerKey,
            itemKey: target.itemKey,
            ...(target.focus ? { changeId: target.focus.id } : {}),
          },
        );
        return Promise.resolve(committed(target.documentId));
      }
      if (!openEditorReview)
        throw new Error("Opening a draft requires the project review handoff owner");
      return openEditorReview(target).then(
        () => committed(target.documentId),
        (error): OpenDocumentOutcome => {
          console.error("[editor-review] launch failed", error);
          return { kind: "cancelled" };
        },
      );
    },
    [hold, openEditorReview],
  );
}

export function useAiDraftLauncher() {
  const openDraft = useOpenDraft();
  const openAiDraft = useCallback(
    (target: AiDraftLaunchTarget) => void openDraft(target),
    [openDraft],
  );

  /** Opens a listed draft in review. A draft with no address yet (still being written) has nothing to open. */
  const openReviewFile = useCallback(
    (row: ReviewFileTarget, ownerKey: string, focus?: ReviewFocus) =>
      row.contextLocation &&
      openAiDraft({
        ownerKey,
        documentId: row.documentId,
        itemKey: row.draft.itemKey,
        contextLocation: row.contextLocation,
        documentName: row.documentName ?? undefined,
        draftOnly: row.draftOnly,
        ...(focus ? { focus } : {}),
      }),
    [openAiDraft],
  );

  return { openAiDraft, openReviewFile };
}

/**
 * Where one followed link goes. `live` is the surface's own opener for a live page in main;
 * `workId` is the Work the link names, which a hold beside keeps.
 */
export type LinkPlacement = (
  document: LinkDocumentRef,
  gesture: LinkFollowDisposition,
  live: (document: LinkDocumentRef, gesture: LinkFollowDisposition) => Promise<OpenDocumentOutcome>,
  workId?: string | null,
) => Promise<OpenDocumentOutcome>;

/**
 * What a followed link opens: the one rule for links in a chat or a page, a chat's doors and its
 * "Drafted N documents" rows. The pane is `useHoldBeside`'s.
 * - A page only a draft holds (`document.review`) opens on that draft.
 * - A page `ownerKey` drafted opens on that draft, as the draft strip does.
 * - Any other page opens live, held beside in the link's Work, or through `live` in main. A page
 *   in the trash opens in main.
 */
export function useLinkPlacement(projectId: string | null, ownerKey: string | null): LinkPlacement {
  const { fileForDocument } = useOwnerDrafts(projectId, ownerKey);
  const openDraft = useOpenDraft();
  const hold = useHoldBeside();
  return useCallback(
    (document, gesture, live, workId) => {
      if (document.review)
        return openDraft({
          documentId: document.documentId,
          ...document.review,
          draftOnly: true,
        });
      if (document.trashed) return live(document, gesture);
      const drafted = ownerKey ? fileForDocument(document.documentId) : null;
      if (ownerKey && drafted?.contextLocation)
        return openDraft({
          ownerKey,
          documentId: document.documentId,
          itemKey: drafted.draft.itemKey,
          contextLocation: drafted.contextLocation,
          documentName: drafted.documentName ?? undefined,
          draftOnly: drafted.draftOnly,
        });
      if (!hold) return live(document, gesture);
      hold({ documentId: document.documentId, ...(workId ? { workId } : {}) });
      return Promise.resolve(committed(document.documentId));
    },
    [fileForDocument, ownerKey, openDraft, hold],
  );
}
