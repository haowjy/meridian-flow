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
import { useLayoutEffect } from "react";
import type { ContextTab } from "@/client/stores";
import { isDraftOnly } from "@/client/stores";
import { PaintCapture, PaintHold } from "@/components/app/PaintHold";
import { PassageNotice } from "@/features/editor/PassageNotice";
import { useContextRemovalCoordinator } from "../context/account-feature-context";
import { ContextDocumentHost, type EditableContextTab } from "../context/ContextDocumentHost";
import { ContextViewerBareHost } from "../context/ContextViewerHost";
import { resolveWorkspaceRoute } from "../context/context-route-workspace-owner";
import { PHONE_DOCUMENT_PRESENTATION } from "../context/document-presentation";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import { useDockArchivedWork } from "../dock/DockDocumentIdentity";
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
        surface={`${props.localTab ? "local" : props.route.tab && isDraftOnly(props.route.tab) ? "draft-only" : "server"}:${props.localTab?.documentId ?? props.route.tab?.documentId ?? props.route.path}`}
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
  if (tab?.kind === "tracked" && isDraftOnly(tab))
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
      projectId={projectId}
      tab={tab}
      // A draft-only document has no live version to return to: its review closes the document.
      onCloseDraftOnly={() => {
        const closing = removal.writerClose(projectId, tab);
        if (closing instanceof Promise) closing.catch((error: unknown) => reportError(error));
      }}
    >
      <PhoneDocument projectId={projectId} tab={tab} />
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
  // No review wraps a local pointer, so it brings the column `MobileDocumentReview` gives the
  // other two: the frame below takes its height from a flex parent.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PhoneDocument projectId={projectId} tab={tab} />
    </div>
  );
}

/**
 * The phone's one editable document. It renders the shared session boundary directly: the
 * phone has a single document, and a warm-set host would add a frame of its own. The host
 * fills this `relative` frame, which is a direct child of a flex column: the review's, or the
 * local pointer's own.
 */
function PhoneDocument({
  projectId,
  tab,
  children,
}: {
  projectId: string;
  tab: EditableContextTab;
  children?: React.ReactNode;
}) {
  // The room's scope follows the Work; the presentation is what keeps the phone from typing.
  const archived = useDockArchivedWork(projectId, tab);
  return (
    <div className="relative min-h-0 flex-1">
      {children}
      <ContextDocumentHost
        container="editor"
        projectId={projectId}
        tab={tab}
        active
        readOnly={Boolean(archived)}
        presentation={PHONE_DOCUMENT_PRESENTATION}
      />
    </div>
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
      selection.locator.workId !== workId ||
      selection.locator.rootThreadId !== (route.rootThreadId ?? undefined)
    )
      return;
    // The live catalog says nothing about a pending draft: its tab is the identity.
    const catalogSettled = !isFetching && !isError;
    const draftOnly = activeTab !== null && isDraftOnly(activeTab);
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
    route.rootThreadId,
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
  const activeContextScheme = route.scheme;
  const activeContextPath = route.path;
  const activeTab = route.tab;
  const { catalogResolved, addressState, isError, isFetching } = route;
  useMobileRouteBinding({ projectId, workId, route, activate: true });

  const opening = Boolean(
    activeContextScheme &&
      activeContextPath &&
      !activeTab &&
      (addressState === "pending" ||
        (isFetching && !catalogResolved) ||
        !(isError || catalogResolved)),
  );
  const capture = (
    <PaintCapture
      state={opening ? "pending" : isError ? "failed" : "painted"}
      surface={opening ? "opening" : isError ? "error" : "viewer"}
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

  // The editable document goes through the shared session boundary, so a stranded adoption
  // resumes and a failed open can retry. The phone keeps its route and its review presentation.
  return (
    <MobileDocumentReview projectId={projectId} tab={activeTab}>
      {capture}
      <PhoneDocument projectId={projectId} tab={activeTab}>
        <PassageNotice documentId={activeTab.documentId} />
      </PhoneDocument>
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
