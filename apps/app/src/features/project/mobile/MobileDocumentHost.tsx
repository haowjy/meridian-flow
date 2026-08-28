/**
 * MobileDocumentHost — read-only phone document/viewer host with registry retention.
 *
 * Mobile never lets users type into collaborative documents, but it keeps the
 * TipTap/Yjs binding alive so AI edits stream into the read-only editor. This
 * host is the mobile registry owner: entering a document retains exactly that
 * document; leaving the view releases it so sessions do not leak. Mobile route
 * navigation deliberately derives the active tab from the context tree instead
 * of writing to the desktop tab strip's shared open-tab set.
 *
 * Renders no filename chrome of its own — the top bar's breadcrumb names the
 * document, so content starts immediately under the top bar.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { AlertCircle, Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo } from "react";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { useContextRemovalCoordinator } from "../context/ContextRemovalAccountProvider";
import { ContextViewerBareHost } from "../context/ContextViewerHost";
import { contextTabFromFile } from "../context/context-tab-from-file";
import { findContextFile } from "../context/context-tree";
import { useContextRemovalProject } from "../context/use-context-removal-project";

const EditorView = lazy(() =>
  import("@/features/editor/EditorView").then((m) => ({ default: m.EditorView })),
);

const MOBILE_DOCUMENT_OWNER = "mobile-project-document-host";

export type MobileDocumentHostProps = {
  projectId: string;
  editorWorkId: string | null;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
};

export function MobileDocumentHost({
  projectId,
  editorWorkId,
  activeContextScheme,
  activeContextPath,
}: MobileDocumentHostProps) {
  const workId = editorWorkId;
  const contextRemoval = useContextRemovalCoordinator();
  const removalState = useContextRemovalProject(projectId);
  const { controller, reviewRoomNameForDraft, setActiveEditorDocumentId } = useDraftReview();
  const hasRouteDocument = activeContextScheme !== null && activeContextPath !== null;
  const { tree, isError, isFetching } = useProjectContextTree(
    projectId,
    activeContextScheme ?? "kb",
    { enabled: hasRouteDocument, workId: editorWorkId },
  );

  const activeTab = useMemo(() => {
    if (!hasRouteDocument || activeContextScheme === null || activeContextPath === null || !tree) {
      return null;
    }
    const file = findContextFile(tree, activeContextPath);
    return file ? contextTabFromFile(activeContextScheme, file, workId) : null;
  }, [activeContextPath, activeContextScheme, hasRouteDocument, tree, workId]);

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
    } else if (selection.status === "candidate" && tree && !isFetching && !isError) {
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
    tree,
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
  useEffect(() => {
    setActiveEditorDocumentId(activeEditorDocumentId);
    return () => setActiveEditorDocumentId(null);
  }, [activeEditorDocumentId, setActiveEditorDocumentId]);
  const selectedReviewDraftId =
    activeEditorDocumentId && controller.inlineReview?.documentId === activeEditorDocumentId
      ? controller.inlineReview.draftId
      : null;
  const reviewRoomName =
    activeEditorDocumentId && selectedReviewDraftId
      ? reviewRoomNameForDraft(activeEditorDocumentId, selectedReviewDraftId)
      : null;
  const reviewDraftId = reviewRoomName ? selectedReviewDraftId : null;

  useEffect(() => {
    if (!activeEditorDocumentId || !selectedReviewDraftId) return;
    const session = getDocumentSessionRegistry().get(activeEditorDocumentId);
    session.suspendPresence();
    return () => session.resumePresence();
  }, [activeEditorDocumentId, selectedReviewDraftId]);

  useEffect(() => {
    if (activeTab?.editable) {
      getDocumentSessionRegistry().retain(MOBILE_DOCUMENT_OWNER, [activeTab.documentId]);
      return () => getDocumentSessionRegistry().retain(MOBILE_DOCUMENT_OWNER, []);
    }
    getDocumentSessionRegistry().retain(MOBILE_DOCUMENT_OWNER, []);
    return undefined;
  }, [activeTab]);

  useEffect(() => {
    return () => getDocumentSessionRegistry().release(MOBILE_DOCUMENT_OWNER);
  }, []);

  if (!activeContextScheme || !activeContextPath) {
    return (
      <DocumentStatus tone="muted">
        <Trans>Select a document.</Trans>
      </DocumentStatus>
    );
  }

  if (!activeTab) {
    if (isFetching && !tree) {
      return (
        <DocumentStatus tone="muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <Trans>Opening document…</Trans>
        </DocumentStatus>
      );
    }
    if (isError || tree) {
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
