import { type DocumentId, type DraftId, draftItemKey } from "@meridian/contracts";
import type { EventRecord } from "@meridian/contracts/observability";
import { createContext, type ReactNode, useCallback, useContext, useRef } from "react";
import { setDocumentView } from "@/client/project-shell/document-views";
import { useOwnerDrafts } from "@/client/query/useOwnerDrafts";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import type { OpenDocumentOutcome } from "@/client/stores";
import { appendTraceEvent } from "@/client/trace-store";
import { DEBUG_FEATURE_ALLOWED } from "@/core/debug-gate";
import { claimDocumentTarget, whenEditorMounted } from "@/core/editor/reading-position-navigation";
import type { LinkDocumentRef } from "@/features/links";
import type { ContextUri } from "@/lib/context-uri";
import { escapeCssIdent } from "@/lib/css-selector";
import { useAccountId } from "./context/account-feature-context";
import { openDocumentFromDraftGroup } from "./context/open-document-from-draft";
import { useOpenProjectDocument } from "./context/open-project-document";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";
import type { ReviewTarget } from "./routing/project-address";
import { contextRouteRequest } from "./routing/project-route";
import { useOptionalPlaceHere } from "./side/SideView";
import { useShellTreeVersion } from "./tree-version";

export type ItemLaunchTarget = {
  draftId: string;
  documentId: string;
  itemKey: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
  documentName?: string;
  draftOnly?: boolean;
  review?: ReviewTarget;
  focus?: { id: string };
  made?: true;
  replace?: true;
};

type EditorReviewCommand = (target: ItemLaunchTarget) => Promise<void>;

function reportRouteSettlement(
  projectId: string,
  target: ItemLaunchTarget,
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
      draftId: target.draftId,
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
          pin: { draftId: target.draftId, itemKey: target.itemKey },
        });
      const tab = openDocumentFromDraftGroup(target);
      const launch = ++sequence.current;
      const releaseTarget = claimDocumentTarget(target.documentId);
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const result = await openContextRoute(
            contextRouteRequest({
              ...target.contextLocation,
              documentId: target.documentId,
            }),
            {
              ...(target.replace ? { replace: true } : { replaceIfSameDocument: true }),
              document: tab ?? undefined,
              draftOnly: target.draftOnly,
              itemKey: target.itemKey,
              review: target.review,
              changeId: target.review ? target.focus?.id : undefined,
              ...(target.made ? { focus: true as const } : {}),
              canCommit: () => sequence.current === launch,
              afterCommit: pin,
            },
          );
          reportRouteSettlement(projectId, target, result.kind, attempt + 1);
          if (result.kind === "failed") throw result.error;
          if (result.kind === "applied") {
            await whenEditorMounted(target.documentId, AbortSignal.timeout(5_000));
            return;
          }
          if (result.kind !== "superseded" || sequence.current !== launch) return;
        }
      } finally {
        releaseTarget();
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

function useOptionalOpenEditorReview(): EditorReviewCommand | null {
  return useContext(EditorReviewCommandContext);
}

const committed = (documentId: string): OpenDocumentOutcome => ({ kind: "committed", documentId });

function useOpenItem(): (target: ItemLaunchTarget) => Promise<OpenDocumentOutcome> {
  const openEditorReview = useOptionalOpenEditorReview();
  const place = useOptionalPlaceHere();
  const shell = useShellTreeVersion();
  const showsWork = shell?.show;
  const workOwner = shell?.draftId;
  return useCallback(
    (target) => {
      if (showsWork && target.draftId === workOwner) showsWork("draft");
      const draft = {
        draftId: target.draftId,
        itemKey: target.itemKey,
        ...(target.review
          ? { review: target.review, ...(target.focus ? { changeId: target.focus.id } : {}) }
          : {}),
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
    [place, openEditorReview, showsWork, workOwner],
  );
}

function fileTarget(row: ReviewFileTarget, draftId: string): ItemLaunchTarget | null {
  if (!row.contextLocation) return null;
  return {
    draftId,
    documentId: row.documentId,
    itemKey: row.item.itemKey,
    contextLocation: row.contextLocation,
    documentName: row.documentName ?? undefined,
    draftOnly: row.draftOnly,
  };
}

export function useItemLauncher() {
  const open = useOpenItem();
  const openDraft = useCallback(
    (target: ItemLaunchTarget) => {
      void open({ ...target, review: undefined, focus: undefined });
    },
    [open],
  );
  const openReview = useCallback(
    (target: ItemLaunchTarget) => {
      void open({ ...target, review: target.review ?? "live" }).then((outcome) => {
        if (outcome.kind === "committed") focusReviewControls(target.documentId);
      });
    },
    [open],
  );
  const openDraftFile = useCallback(
    (row: ReviewFileTarget, draftId: string) => {
      const target = fileTarget(row, draftId);
      if (target) openDraft(target);
    },
    [openDraft],
  );
  const openReviewFile = useCallback(
    (row: ReviewFileTarget, draftId: string, change?: string) => {
      const target = fileTarget(row, draftId);
      if (target) openReview(change ? { ...target, focus: { id: change } } : target);
    },
    [openReview],
  );

  return { openDraft, openReview, openDraftFile, openReviewFile };
}

export type CreatedDocument = {
  documentId: string;
  contextLocation: Pick<ContextUri, "scheme" | "path">;
  documentName?: string;
};

export function useOpenCreatedDocument(): (
  document: CreatedDocument,
  live: () => Promise<void>,
  opened?: () => void,
) => Promise<void> {
  const shell = useShellTreeVersion();
  const { openDraft } = useItemLauncher();
  const shown = shell?.version.view.draft ?? null;
  return useCallback(
    async (document, live, opened) => {
      if (!shown) return live();
      openDraft({
        draftId: shown,
        documentId: document.documentId,
        itemKey: draftItemKey(shown as DraftId, document.documentId as DocumentId),
        contextLocation: document.contextLocation,
        documentName: document.documentName,
        draftOnly: true,
        made: true,
      });
      opened?.();
    },
    [shown, openDraft],
  );
}

export type LinkPlacement = (
  document: LinkDocumentRef,
  live: (document: LinkDocumentRef, placeBeside?: () => boolean) => Promise<OpenDocumentOutcome>,
  workId?: string | null,
) => Promise<OpenDocumentOutcome>;

export function useLinkPlacement(projectId: string | null, draftId: string | null): LinkPlacement {
  const { fileForDocument } = useOwnerDrafts(projectId, draftId);
  const openItem = useOpenItem();
  const place = useOptionalPlaceHere();
  return useCallback(
    (document, live, workId) => {
      if (document.review)
        return openItem({
          documentId: document.documentId,
          ...document.review,
          draftOnly: true,
        });
      if (document.trashed) return live(document);
      const drafted = draftId ? fileForDocument(document.documentId) : null;
      if (draftId && drafted?.contextLocation)
        return openItem({
          draftId,
          documentId: document.documentId,
          itemKey: drafted.item.itemKey,
          contextLocation: drafted.contextLocation,
          documentName: drafted.documentName ?? undefined,
          draftOnly: drafted.draftOnly,
        });
      const placed = {
        kind: "document",
        documentId: document.documentId,
        ...(workId ? { workId } : {}),
      } as const;
      return live(document, place ? () => place(placed) === "side" : undefined);
    },
    [fileForDocument, draftId, openItem, place],
  );
}

export function useOpenPlacedDocument(
  projectId: string | undefined,
): (documentId: string) => Promise<OpenDocumentOutcome> {
  const openDocument = useOpenProjectDocument(projectId);
  const place = useLinkPlacement(projectId ?? null, null);
  return useCallback(
    (documentId) =>
      place({ documentId }, (found, placeBeside) =>
        openDocument({ documentId: found.documentId, placeBeside }),
      ),
    [place, openDocument],
  );
}

export function focusReviewControls(documentId: string): void {
  let frames = 30;
  const attempt = () => {
    const bar = document.querySelector<HTMLElement>(
      `[data-review-bar="${escapeCssIdent(documentId)}"]`,
    );
    const target =
      bar?.querySelector<HTMLElement>("[data-review-stepper]") ??
      bar?.querySelector<HTMLElement>(":scope > button:last-of-type");
    if (target) target.focus();
    else if (--frames > 0) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
