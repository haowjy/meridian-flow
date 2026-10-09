/**
 * MobileDocumentHost — phone document/viewer host with route-owned binding.
 *
 * The live document is read-only on a phone, but its TipTap/Yjs binding stays
 * alive so AI edits stream into it. While the document is under inline review
 * `MobileDocumentReview` wraps the editor with the review's header, bar and
 * change list. This
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
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ContextTab } from "@/client/stores";
import { PaintCapture, PaintHold } from "@/components/app/PaintHold";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { EditorView } from "@/features/editor/EditorView";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { useContextRemovalCoordinator } from "../context/account-feature-context";
import { ContextEditorMountHost } from "../context/ContextEditorMountHost";
import { ContextViewerBareHost } from "../context/ContextViewerHost";
import { resolveWorkspaceRoute } from "../context/context-route-workspace-owner";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import { useLiveDocumentBinding } from "../context/use-live-document-binding";
import { useRefusedEditsReopen } from "../context/use-refused-edits-reopen";
import { useRequestedReview } from "../dock/editor-review-handoff";
import { MobileDocumentReview } from "./MobileDocumentReview";
import type { MobileDocumentRoute } from "./mobile-document-route";

export type MobileDocumentHostProps = {
  projectId: string;
  editorWorkId: string;
  route: MobileDocumentRoute;
  localTab?: Extract<ContextTab, { kind: "new" | "tracked" }>;
};

/**
 * One frame around whichever host the route resolves to, so the review being
 * left stays painted over the document column while the next one opens (the
 * hosts below swap, and a status line replaces the editor, as the route settles).
 */
export function MobileDocumentHost(props: MobileDocumentHostProps) {
  const name = props.localTab?.name ?? props.route.tab?.name;
  return (
    <PaintHold
      status={name ? t`Opening ${name}` : t`Opening draft`}
      className="relative h-full min-h-0"
    >
      <PaintCapture
        surface={`${props.localTab ? "local" : props.route.tab?.kind === "tracked" && props.route.tab.draftOnly ? "draft-only" : "server"}:${props.localTab?.documentId ?? props.route.tab?.documentId ?? props.route.path}`}
      />
      <MobileDocumentHostForRoute {...props} />
    </PaintHold>
  );
}

function MobileDocumentHostForRoute(props: MobileDocumentHostProps) {
  if (props.localTab)
    return (
      <MobileLocalDocumentHost
        projectId={props.projectId}
        workId={props.editorWorkId}
        tab={props.localTab}
      />
    );
  const tab = props.route.tab;
  // A pending new-document draft has no live room and the server refuses one: its
  // branch is hosted alone, exactly as the desktop does.
  if (tab?.kind === "tracked" && tab.draftOnly)
    return <MobileDraftOnlyDocumentHost {...props} tab={tab} />;
  return <MobileServerDocumentHost {...props} />;
}

function MobileDraftOnlyDocumentHost({
  projectId,
  editorWorkId,
  route,
  tab,
}: MobileDocumentHostProps & { tab: Extract<ContextTab, { kind: "tracked" }> }) {
  // The route is bound to the draft's document, but never remembered or activated: its
  // path dies if the draft is discarded.
  useMobileRouteBinding({ projectId, workId: editorWorkId, route, activate: false });
  const removal = useContextRemovalCoordinator();
  return (
    <MobileDocumentReview
      documentId={tab.documentId}
      // A draft-only document has no live version to return to: its review closes the document.
      onCloseDraftOnly={() => {
        const closing = removal.writerClose(projectId, tab.documentId);
        if (closing instanceof Promise) closing.catch((error: unknown) => reportError(error));
      }}
    >
      <ContextEditorMountHost
        projectId={projectId}
        trackedTabs={[tab]}
        activeTabId={tab.documentId}
        active
        readOnly
      />
    </MobileDocumentReview>
  );
}

function MobileLocalDocumentHost({
  projectId,
  workId,
  tab,
}: {
  projectId: string;
  workId: string;
  tab: Extract<ContextTab, { kind: "new" | "tracked" }>;
}) {
  const removal = useContextRemovalCoordinator();
  const state = useContextRemovalProject(projectId);
  useLayoutEffect(() => {
    const selected = state.selection;
    if (
      selected.status === "none" ||
      selected.locator.scheme !== "unfiled" ||
      selected.locator.path !== "" ||
      selected.locator.workId !== workId
    )
      return;
    const workspace = resolveWorkspaceRoute({
      tabs: [tab],
      selectedDocumentId: tab.documentId,
      locator: selected.locator,
    });
    if (workspace.kind === "materialized-local") {
      removal.redirectMaterializedLocal(
        projectId,
        selected.revision,
        tab.documentId,
        workspace.target,
      );
    } else if (workspace.kind === "owner") {
      if (selected.status === "candidate")
        removal.bindRouteSelection(projectId, selected.revision, workspace.identity);
      else if (selected.status === "bound" && selected.identity.documentId === tab.documentId)
        removal.activate({
          projectId,
          selectionRevision: selected.revision,
          transitionRevision: state.transitionRevision,
          locator: selected.locator,
          identity: selected.identity,
          owner: { kind: "route-only" },
        });
    }
  }, [projectId, workId, tab, removal, state]);
  return (
    <ContextEditorMountHost
      projectId={projectId}
      trackedTabs={[tab]}
      activeTabId={tab.documentId}
      active
      readOnly
    />
  );
}

/**
 * Binds the routed locator to the document the route resolved to, or rejects it once the
 * catalog has settled without one. `activate` marks the route as the one to remember.
 */
function useMobileRouteBinding({
  projectId,
  workId,
  route,
  activate,
}: {
  projectId: string;
  workId: string;
  route: MobileDocumentRoute;
  activate: boolean;
}) {
  const contextRemoval = useContextRemovalCoordinator();
  const removalState = useContextRemovalProject(projectId);
  const hasRouteDocument = route.requested;
  const activeContextScheme = route.scheme;
  const activeContextPath = route.path;
  const activeTab = route.tab;
  const { catalogResolved, addressState, isError, isFetching } = route;

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
    // The live catalog says nothing about a pending draft: its tab is the identity.
    const catalogSettled = !isFetching && !isError;
    const draftOnly = activeTab?.kind === "tracked" && activeTab.draftOnly === true;
    if (activeTab && (draftOnly || catalogSettled)) {
      contextRemoval.bindRouteSelection(projectId, selection.revision, {
        kind: "server",
        documentId: activeTab.documentId,
      });
    } else if (
      selection.status === "candidate" &&
      catalogResolved &&
      catalogSettled &&
      addressState === "settled"
    ) {
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
    addressState,
    workId,
  ]);

  useLayoutEffect(() => {
    if (
      !activate ||
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
  }, [activate, activeTab, contextRemoval, projectId, removalState]);
}

function MobileServerDocumentHost({ projectId, editorWorkId, route }: MobileDocumentHostProps) {
  const workId = editorWorkId;
  const projectionOwner = useRef({});
  const { controller, reviewRoomNameForDraft, setActiveEditorDocumentId } = useDraftReview();
  const activeContextScheme = route.scheme;
  const activeContextPath = route.path;
  const activeTab = route.tab;
  const { catalogResolved, addressState, isError, isFetching } = route;
  useMobileRouteBinding({ projectId, workId, route, activate: true });

  const activeEditorDocumentId = activeTab?.editable ? activeTab.documentId : null;
  const selectedReviewDraftId = useRequestedReview({
    editorWorkId,
    activeScheme: activeContextScheme,
    documentId: activeEditorDocumentId,
  });
  const reviewRoomName =
    activeEditorDocumentId && selectedReviewDraftId
      ? reviewRoomNameForDraft(activeEditorDocumentId, selectedReviewDraftId)
      : null;
  const reviewDraftId = selectedReviewDraftId;

  const live = useLiveDocumentBinding({
    projectId,
    documentId: activeTab?.editable ? activeTab.documentId : null,
    owner: "mobile-project-document-host",
  });
  const liveState = live.state;
  const bindableLiveSession = useRefusedEditsReopen(
    liveState.kind === "opened" ? liveState.session : null,
    live.retry,
  );

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

  const failed = liveState.kind === "failed" && liveState.documentId === activeTab?.documentId;
  const opening = Boolean(
    activeContextScheme &&
      activeContextPath &&
      (!activeTab
        ? addressState === "pending" ||
          (isFetching && !catalogResolved) ||
          !(isError || catalogResolved)
        : activeTab.editable && !failed && !bindableLiveSession),
  );
  const capture = (
    <PaintCapture
      state={opening ? "pending" : failed || isError ? "failed" : "painted"}
      surface={
        opening
          ? "opening"
          : failed || isError
            ? "error"
            : activeTab?.editable
              ? "editor"
              : "viewer"
      }
    />
  );
  if (!activeContextScheme || !activeContextPath) {
    return (
      <DocumentStatus capture={capture} tone="muted">
        <Trans>Select a document.</Trans>
      </DocumentStatus>
    );
  }

  if (!activeTab) {
    if (addressState === "pending" || (isFetching && !catalogResolved)) {
      return (
        <DocumentStatus capture={capture} tone="muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          <Trans>Opening document…</Trans>
        </DocumentStatus>
      );
    }
    if (isError || catalogResolved) {
      return (
        <DocumentStatus capture={capture} tone="error">
          <AlertCircle className="size-4" aria-hidden />
          <Trans>Couldn't open this document.</Trans>
        </DocumentStatus>
      );
    }
    return capture;
  }

  if (!activeTab.editable) {
    return (
      <>
        {capture}
        <ContextViewerBareHost projectId={projectId} editorWorkId={editorWorkId} tab={activeTab} />
      </>
    );
  }

  const liveSession =
    liveState.kind === "opened" && liveState.documentId === activeTab.documentId
      ? bindableLiveSession
      : null;
  if (liveState.kind === "failed" && liveState.documentId === activeTab.documentId) {
    return (
      <DocumentStatus capture={capture} tone="error">
        <AlertCircle className="size-4" aria-hidden />
        <Trans>Couldn't open this document.</Trans>
      </DocumentStatus>
    );
  }
  if (!liveSession) {
    return (
      <DocumentStatus capture={capture} tone="muted">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        <Trans>Opening document…</Trans>
      </DocumentStatus>
    );
  }

  return (
    <MobileDocumentReview documentId={activeTab.documentId}>
      {capture}
      <div className="relative min-h-0 flex-1">
        <PassageNotice documentId={activeTab.documentId} />
        <EditorView
          projectId={projectId}
          documentId={activeTab.documentId}
          session={liveSession}
          schemaType={activeTab.schemaType}
          // Read-only under review as well: a tap must select a change, not raise the
          // keyboard over its bar, and the phone has no editing chrome (the desktop's
          // block grip would show). The desktop edits the draft while it reviews.
          editable={false}
          showToolbar={false}
          ariaLabel={t`Read-only live document`}
          showCollaborationDecorations={false}
          reviewDraftId={reviewDraftId}
          reviewRoomName={reviewRoomName}
          reviewWorkId={reviewDraftId ? controller.workId : null}
          onReviewSessionUnavailable={controller.exitInlineReview}
        />
      </div>
    </MobileDocumentReview>
  );
}

function DocumentStatus({
  children,
  tone,
  capture,
}: {
  capture?: React.ReactNode;
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
      {capture}
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
