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
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { ReviewFileTarget } from "@/client/query/work-branch-files";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import type { LinkFollowDisposition } from "@/core/editor/links";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";
import type { ReviewFocus } from "@/features/draft-review/review-model";
import type { LinkDestination, LinkDocumentRef } from "@/features/links";
import type { ContextUri } from "@/lib/context-uri";
import { useAccountId } from "./context/account-feature-context";
import { openDocumentFromDraftGroup } from "./context/open-document-from-draft";
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
 * Where one followed link goes. `live` is the surface's own opener for a plain click on a live
 * page; `workId` is the Work the link names, which a hold beside keeps.
 */
export type LinkPlacement = (
  document: LinkDocumentRef,
  gesture: LinkFollowDisposition,
  live: LinkDestination,
  workId?: string | null,
) => Promise<unknown>;

/**
 * What a followed link opens: the one rule for links in a chat or a page, a chat's doors and its
 * "Drafted N documents" rows.
 * - A page only a draft holds (`document.review`) opens in main on that draft, whatever the
 *   gesture: it can't be held beside.
 * - A page `ownerKey` drafted opens on that draft: a plain click in main, as the draft strip does;
 *   a cmd-click, ctrl-click or middle click holds it beside, on that draft (a page only the draft
 *   has opens in main).
 * - Any other page: a plain click goes to `live`; the other gestures hold it beside, in the
 *   link's Work. A page in the trash opens in main.
 */
export function useLinkPlacement(projectId: string | null, ownerKey: string | null): LinkPlacement {
  const { fileForDocument } = useOwnerDrafts(projectId, ownerKey);
  const openEditorReview = useOptionalOpenEditorReview();
  const holdBeside = useOptionalHoldBeside();
  return useCallback(
    (document, gesture, live, workId) => {
      const hold = gesture === "new-tab" ? holdBeside : null;
      const launch = (target: AiDraftLaunchTarget) => {
        if (!openEditorReview)
          throw new Error("Opening a draft requires the project review handoff owner");
        return openEditorReview(target).catch((error) => {
          console.error("[editor-review] launch failed", error);
        });
      };
      if (document.review)
        return launch({ documentId: document.documentId, ...document.review, draftOnly: true });
      if (document.trashed) return live(document, gesture);
      const drafted = ownerKey ? fileForDocument(document.documentId) : null;
      if (ownerKey && drafted?.contextLocation) {
        if (hold && !drafted.draftOnly) {
          hold(
            { kind: "document", documentId: document.documentId },
            { ownerKey, itemKey: drafted.draft.itemKey },
          );
          return Promise.resolve();
        }
        return launch({
          ownerKey,
          documentId: document.documentId,
          itemKey: drafted.draft.itemKey,
          contextLocation: drafted.contextLocation,
          documentName: drafted.documentName ?? undefined,
          draftOnly: drafted.draftOnly,
        });
      }
      if (hold) {
        hold({ kind: "document", documentId: document.documentId, ...(workId ? { workId } : {}) });
        return Promise.resolve();
      }
      return live(document, gesture);
    },
    [fileForDocument, ownerKey, openEditorReview, holdBeside],
  );
}
