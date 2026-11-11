/**
 * The one review-launch path. Every launcher (the composer strip, a change card, a link to a draft,
 * the Work page, the version menu, the phone) calls `openAiDraft`: it sets the document's view to
 * that draft, with the clicked change as the pin's change, and opens the document in main: the
 * route command opens it and writes the address. Main's host then paints the draft and focuses
 * the change. Latest launch wins.
 */

import type { EventRecord } from "@meridian/contracts/observability";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef } from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";
import type { ReviewFocus } from "@/features/draft-review/review-model";
import type { LinkDestination } from "@/features/links";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import type { ContextUri } from "@/lib/context-uri";
import { useAccountId } from "./context/account-feature-context";
import { contextTabFromDraftGroup } from "./context/context-tab-from-draft";
import {
  type BesideHint,
  type OpenContextRoute,
  useOpenedFromChat,
} from "./routing/ProjectNavigationContext";
import { contextRouteRequest } from "./routing/project-route";
import { useOptionalHoldBeside } from "./side/SideView";

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
  /** The chat the launch was made from: the new entry keeps it beside the document. */
  beside?: BesideHint;
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
      const tab = contextTabFromDraftGroup(target);
      const launch = ++sequence.current;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await openContextRoute(
          contextRouteRequest({
            ...target.contextLocation,
            documentId: target.documentId,
          }),
          {
            replaceIfSameDocument: true,
            tab: tab ?? undefined,
            draftOnly: target.draftOnly,
            itemKey: target.itemKey,
            reviewOwner: target.ownerKey,
            changeId: target.focus?.id,
            ...(target.beside ? { beside: target.beside } : {}),
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

export function useOpenEditorReview(): EditorReviewCommand {
  const command = useOptionalOpenEditorReview();
  if (!command) throw new Error("Opening a draft requires the project review handoff owner");
  return command;
}

/** For a surface that only sometimes launches a review (a link to a draft), and may mount without an owner. */
export function useOptionalOpenEditorReview(): EditorReviewCommand | null {
  const command = useContext(EditorReviewCommandContext);
  const beside = useOpenedFromChat();
  return useMemo(
    () =>
      command && beside ? (target: AiDraftLaunchTarget) => command({ beside, ...target }) : command,
    [command, beside],
  );
}

export function useAiDraftLauncher() {
  const openEditorReview = useOpenEditorReview();
  const openAiDraft = useCallback(
    (target: AiDraftLaunchTarget) => {
      void openEditorReview(target).catch((error) => {
        console.error("[editor-review] launch failed", error);
      });
    },
    [openEditorReview],
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
 * A link destination that sends a document living only in a draft to that
 * Work's review (by item identity, as the review launch does), and every
 * other document to the surface's own live opener.
 */
export function useReviewingLinkDestination(
  open: LinkDestination,
  /** The Work the link's surface opens documents in; a hold beside keeps it. */
  workId?: string,
): LinkDestination {
  const openEditorReview = useOptionalOpenEditorReview();
  const holdBeside = useOptionalHoldBeside();
  // The phone's side holds chats only: a background open there opens in main.
  const phone = usePhoneShell() === true;
  return useCallback(
    (document, gesture) => {
      const { review } = document;
      // A cmd-click (or middle click) opens the document beside main, where it is held.
      if (!review && gesture === "new-tab" && holdBeside && !phone) {
        holdBeside({
          kind: "document",
          documentId: document.documentId,
          ...(workId ? { workId } : {}),
        });
        return Promise.resolve();
      }
      if (!review) return open(document, gesture);
      // A hidden target exists only in the draft: it is a draft-only review, never a live tab.
      const target: AiDraftLaunchTarget = {
        documentId: document.documentId,
        ...review,
        draftOnly: true,
      };
      if (!openEditorReview)
        throw new Error("Opening a draft requires the project review handoff owner");
      return openEditorReview(target).catch((error) => {
        console.error("[editor-review] launch failed", error);
      });
    },
    [open, openEditorReview, holdBeside, workId, phone],
  );
}
