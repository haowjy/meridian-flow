/**
 * The one review-launch path. Every launcher (the composer strip, a change card, a link to a draft,
 * the Work page, the version menu, the phone) calls `openAiDraft`: it sets the document's view to
 * that draft, with the clicked change as the pin's change, and opens the document in the pane
 * `place` picks. In main, the route command opens it and writes the address; beside, `place` shows it. That pane's host then paints the draft and focuses the change. Latest launch wins.
 */

import { type BranchId, type DocumentId, draftItemKey } from "@meridian/contracts";
import type { EventRecord } from "@meridian/contracts/observability";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useRef } from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
import {
  cachedOwnerDrafts,
  relistedOwnerDraft,
  useOwnerDrafts,
} from "@/client/query/useOwnerDrafts";
import { projectWorkBranchFiles, type ReviewFileTarget } from "@/client/query/work-branch-files";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { appendTraceEvent } from "@/features/debug/trace/trace-store";
import type { ReviewFocus } from "@/features/draft-review/review-model";
import type { LinkDocumentRef } from "@/features/links";
import type { ContextUri } from "@/lib/context-uri";
import { useAccountId } from "./context/account-feature-context";
import { openDocumentFromDraftGroup } from "./context/open-document-from-draft";
import { type OpenDocumentOutcome, useOpenProjectDocument } from "./context/open-project-document";
import {
  type OpenContextRoute,
  useCaptureProjectNavigation,
} from "./routing/ProjectNavigationContext";
import { contextRouteRequest } from "./routing/project-route";
import { useOptionalPlaceHere } from "./side/SideView";
import { useShellTreeVersion } from "./tree-version";

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
  /** The writer just made the document: its text takes the caret, as one made on Live does. */
  made?: true;
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
            ...(target.made ? { focus: true as const } : {}),
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

const committed = (documentId: string): OpenDocumentOutcome => ({ kind: "committed", documentId });

/** Opens a document on a draft, in the pane `place` picks. */
function useOpenDraft(): (target: AiDraftLaunchTarget) => Promise<OpenDocumentOutcome> {
  const openEditorReview = useOptionalOpenEditorReview();
  const place = useOptionalPlaceHere();
  return useCallback(
    (target) => {
      const draft = {
        ownerKey: target.ownerKey,
        itemKey: target.itemKey,
        ...(target.focus ? { changeId: target.focus.id } : {}),
      };
      if (place?.({ kind: "document", documentId: target.documentId }, draft) === "side")
        return Promise.resolve(committed(target.documentId));
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
    [place, openEditorReview],
  );
}

export function useAiDraftLauncher() {
  const openDraft = useOpenDraft();
  const shell = useShellTreeVersion();
  // A draft of the toggle's Work is that Work's version of the page: the toggle goes to Draft.
  const showsWork = shell?.show;
  const workOwner = shell?.ownerKey;
  const openAiDraft = useCallback(
    (target: AiDraftLaunchTarget) => {
      if (showsWork && target.ownerKey === workOwner) showsWork("draft");
      void openDraft(target);
    },
    [openDraft, showsWork, workOwner],
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
 * Opens a document the writer just made, in the version they made it in. On Live that is `live`,
 * at once. On Draft the create's admission makes the Work's text draft of the document, which only
 * the server can answer for, so the page opens on that draft once the Work's list has it, as a
 * Changes row does: until then the new row shows in the tree and the page stays where it was. A
 * newer navigation, or no answer in time, leaves the row to be opened by hand. `opened` runs once
 * the draft opens (the phone's drawer closes then, as a row's click closes it).
 */
export function useOpenCreatedDocument(
  projectId: string,
): (documentId: string, live: () => Promise<void>, opened?: () => void) => Promise<void> {
  const shell = useShellTreeVersion();
  const { openAiDraft } = useAiDraftLauncher();
  const captureNavigation = useCaptureProjectNavigation();
  const queryClient = useQueryClient();
  const branchId = shell?.version.view.draft ?? null;
  const ownerKey = shell?.ownerKey ?? null;
  return useCallback(
    async (documentId, live, opened) => {
      if (!branchId || !ownerKey) return live();
      const isCurrent = captureNavigation?.() ?? (() => true);
      const itemKey = draftItemKey(branchId as BranchId, documentId as DocumentId);
      if (!(await relistedOwnerDraft(queryClient, projectId, ownerKey, itemKey)) || !isCurrent())
        return;
      const row = cachedOwnerDrafts(queryClient, projectId, ownerKey)?.find(
        (item) => item.itemKey === itemKey,
      );
      const [file] = row ? projectWorkBranchFiles([row], null) : [];
      if (!file?.contextLocation) return;
      openAiDraft({
        ownerKey,
        documentId: file.documentId,
        itemKey: file.draft.itemKey,
        contextLocation: file.contextLocation,
        documentName: file.documentName ?? undefined,
        draftOnly: file.draftOnly,
        made: true,
      });
      opened?.();
    },
    [branchId, ownerKey, projectId, captureNavigation, queryClient, openAiDraft],
  );
}

/**
 * Where one followed link goes. `live` is the surface's own opener for a live page in main;
 * `workId` is the Work the link names, which a hold beside keeps.
 */
export type LinkPlacement = (
  document: LinkDocumentRef,
  live: (document: LinkDocumentRef) => Promise<OpenDocumentOutcome>,
  workId?: string | null,
) => Promise<OpenDocumentOutcome>;

/**
 * What a followed link opens: the one rule for links in a chat or a page, a chat's doors and its
 * "Drafted N documents" rows. The pane is `place`'s.
 * - A page only a draft holds (`document.review`) opens on that draft.
 * - A page `ownerKey` drafted opens on that draft, as the draft strip does.
 * - Any other page opens live, placed beside in the link's Work, or through `live` in main. A page
 *   in the trash opens in main.
 */
export function useLinkPlacement(projectId: string | null, ownerKey: string | null): LinkPlacement {
  const { fileForDocument } = useOwnerDrafts(projectId, ownerKey);
  const openDraft = useOpenDraft();
  const place = useOptionalPlaceHere();
  return useCallback(
    (document, live, workId) => {
      if (document.review)
        return openDraft({
          documentId: document.documentId,
          ...document.review,
          draftOnly: true,
        });
      if (document.trashed) return live(document);
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
      const placed = {
        kind: "document",
        documentId: document.documentId,
        ...(workId ? { workId } : {}),
      } as const;
      if (place?.(placed) !== "side") return live(document);
      return Promise.resolve(committed(document.documentId));
    },
    [fileForDocument, ownerKey, openDraft, place],
  );
}

/**
 * Opens a document by id where `useLinkPlacement` puts it: a chip or a mention in a chat's
 * message or composer.
 */
export function useOpenPlacedDocument(
  projectId: string | undefined,
): (documentId: string) => Promise<OpenDocumentOutcome> {
  const openDocument = useOpenProjectDocument(projectId);
  const place = useLinkPlacement(projectId ?? null, null);
  return useCallback(
    (documentId) =>
      place({ documentId }, (found) => openDocument({ documentId: found.documentId })),
    [place, openDocument],
  );
}
