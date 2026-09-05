/**
 * MobileDocumentHost — read-only phone document/viewer host with route-owned binding.
 *
 * Mobile never lets users type into collaborative documents, but it keeps the
 * TipTap/Yjs binding alive so AI edits stream into the read-only editor. This
 * host is the mobile binding owner: entering a document opens and binds exactly
 * that document; leaving the view releases it so sessions do not leak. Mobile route
 * navigation deliberately derives the active tab from the context tree instead
 * of writing to the desktop tab strip's shared open-tab set.
 *
 * Renders no filename chrome of its own — the top bar's breadcrumb names the
 * document, so content starts immediately under the top bar.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { AlertCircle, Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { useContextRemovalCoordinator } from "../context/account-feature-context";
import { ContextViewerBareHost } from "../context/ContextViewerHost";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import { useLiveDocumentBinding } from "../context/use-live-document-binding";
import { useLiveBindingAcknowledgementHost } from "../dock/editor-review-handoff";
import { usePostApplyHostWake } from "../draft-apply-recovery/ProjectDraftApplyRecoveryExecutor";
import type { MobileDocumentRoute } from "./mobile-document-route";

let mobileHostGeneration = 0;

const EditorView = lazy(() =>
  import("@/features/editor/EditorView").then((m) => ({ default: m.EditorView })),
);

export type MobileDocumentHostProps = {
  projectId: string;
  editorWorkId: string | null;
  route: MobileDocumentRoute;
};

export function MobileDocumentHost({ projectId, editorWorkId, route }: MobileDocumentHostProps) {
  const workId = editorWorkId;
  const projectionOwner = useRef({});
  const hostGeneration = useRef(++mobileHostGeneration);
  const contextRemoval = useContextRemovalCoordinator();
  const removalState = useContextRemovalProject(projectId);
  const { controller, reviewRoomNameForDraft, setActiveEditorDocumentId } = useDraftReview();
  const hasRouteDocument = route.requested;
  const activeContextScheme = route.scheme;
  const activeContextPath = route.path;
  const activeTab = route.tab;
  const { catalogResolved, isError, isFetching } = route;

  useLayoutEffect(() => {
    if (!hasRouteDocument || activeContextScheme === null || activeContextPath === null) return;
    const selection = removalState.selection;
    if (selection.status === "none") return;
    if (
      selection.locator.scheme !== activeContextScheme ||
      selection.locator.path !== activeContextPath ||
      selection.locator.workId !== workId
    )
      return;
    if (activeTab && !isFetching && !isError) {
      contextRemoval.bindRouteSelection(projectId, selection.revision, {
        kind: "server",
        documentId: activeTab.documentId,
      });
    } else if (selection.status === "candidate" && catalogResolved && !isFetching && !isError) {
      contextRemoval.rejectRouteCandidate(projectId, selection.revision);
    }
  }, [
    activeContextPath,
    activeContextScheme,
    activeTab,
    contextRemoval,
    hasRouteDocument,
    isFetching,
    isError,
    projectId,
    removalState.selection,
    catalogResolved,
    workId,
  ]);

  useLayoutEffect(() => {
    if (
      !activeTab ||
      removalState.selection.status !== "bound" ||
      activeTab.documentId !== removalState.selection.identity.documentId
    )
      return;
    contextRemoval.activate({
      projectId,
      selectionRevision: removalState.selection.revision,
      transitionRevision: removalState.transitionRevision,
      locator: removalState.selection.locator,
      identity: removalState.selection.identity,
      owner: { kind: "route-only" },
    });
  }, [activeTab, contextRemoval, projectId, removalState]);

  const activeEditorDocumentId = activeTab?.editable ? activeTab.documentId : null;
  const selectedReviewDraftId =
    activeEditorDocumentId && controller.inlineReview?.documentId === activeEditorDocumentId
      ? controller.inlineReview.draftId
      : null;
  const reviewRoomName =
    activeEditorDocumentId && selectedReviewDraftId
      ? reviewRoomNameForDraft(activeEditorDocumentId, selectedReviewDraftId)
      : null;
  const reviewDraftId = reviewRoomName ? selectedReviewDraftId : null;

  const live = useLiveDocumentBinding({
    projectId,
    documentId: activeTab?.editable ? activeTab.documentId : null,
    owner: "mobile-project-document-host",
  });
  useLiveBindingAcknowledgementHost(projectId, activeEditorDocumentId, live);
  usePostApplyHostWake(projectId, activeEditorDocumentId, hostGeneration.current);
  const liveState = live.state;

  useEffect(() => {
    if (liveState.kind !== "opened" || liveState.documentId !== activeEditorDocumentId) {
      setActiveEditorDocumentId(null, null, false, projectionOwner.current);
      return;
    }
    setActiveEditorDocumentId(
      activeEditorDocumentId,
      liveState.session,
      Boolean(reviewDraftId),
      projectionOwner.current,
    );
    return () => setActiveEditorDocumentId(null, null, false, projectionOwner.current);
  }, [activeEditorDocumentId, liveState, reviewDraftId, setActiveEditorDocumentId]);

  useEffect(() => {
    if (
      !selectedReviewDraftId ||
      liveState.kind !== "opened" ||
      liveState.documentId !== activeEditorDocumentId
    )
      return;
    liveState.session.suspendPresence();
    return () => liveState.session.resumePresence();
  }, [activeEditorDocumentId, liveState, selectedReviewDraftId]);

  if (!activeContextScheme || !activeContextPath) {
    return (
      <DocumentStatus tone="muted">
        <Trans>Select a document.</Trans>
      </DocumentStatus>
    );
  }

  if (!activeTab) {
    if (isFetching && !catalogResolved) {
      return (
        <DocumentStatus tone="muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <Trans>Opening document…</Trans>
        </DocumentStatus>
      );
    }
    if (isError || catalogResolved) {
      return (
        <DocumentStatus tone="error">
          <AlertCircle className="size-4" aria-hidden />
          <Trans>Couldn't open this document.</Trans>
        </DocumentStatus>
      );
    }
    return null;
  }

  if (!activeTab.editable) {
    return (
      <ContextViewerBareHost projectId={projectId} editorWorkId={editorWorkId} tab={activeTab} />
    );
  }

  const liveSession =
    liveState.kind === "opened" && liveState.documentId === activeTab.documentId
      ? liveState.session
      : null;
  if (liveState.kind === "failed" && liveState.documentId === activeTab.documentId) {
    return (
      <DocumentStatus tone="error">
        <AlertCircle className="size-4" aria-hidden />
        <Trans>Couldn't open this document.</Trans>
      </DocumentStatus>
    );
  }
  if (!liveSession) {
    return (
      <DocumentStatus tone="muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <Trans>Opening document…</Trans>
      </DocumentStatus>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <PassageNotice documentId={activeTab.documentId} />
      <Suspense
        fallback={
          <DocumentStatus tone="muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            <Trans>Opening document…</Trans>
          </DocumentStatus>
        }
      >
        <EditorView
          projectId={projectId}
          workId={workId}
          documentId={activeTab.documentId}
          session={liveSession}
          schemaType={activeTab.schemaType}
          editable={false}
          showToolbar={false}
          ariaLabel={t`Read-only live document`}
          showCollaborationDecorations={false}
          reviewDraftId={reviewDraftId}
          reviewRoomName={reviewRoomName}
          reviewWorkId={reviewDraftId ? controller.workId : null}
          onReviewSessionUnavailable={controller.exitInlineReview}
        />
      </Suspense>
    </div>
  );
}

function DocumentStatus({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "muted" | "error";
}) {
  return (
    <div
      className={
        tone === "error"
          ? "grid h-full place-items-center px-6 text-center text-sm text-destructive"
          : "grid h-full place-items-center px-6 text-center text-sm text-muted-foreground"
      }
    >
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
