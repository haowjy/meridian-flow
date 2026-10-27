/**
 * Renders the Editor destination and its active document. A file of an
 * archived Work, and a review of its draft, open read-only under the archived
 * notice. The Editor shows only its own Work's files and drafts, so the
 * Editor's Work is that file's Work. Archiving here freezes them at once; the
 * server's own read-only scope follows.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type {
  ContextOwner,
  CopyContextEntryView,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import type { ContextTab } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { PaintCapture, PaintHold, PaintScope } from "@/components/app/PaintHold";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { ReviewToast } from "@/features/draft-review/ReviewToast";
import {
  isProjectRouteMasked,
  ProjectRouteBoundary,
  type ProjectRouteMask,
} from "../routing/ProjectRouteBoundary";
import type { PaneHeaderRailToggle } from "../shell/PaneHeader";
import { PanelToggleButton } from "../shell/PanelToggleButton";
import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ContextTabBar } from "./ContextTabBar";
import { ContextViewerHost } from "./ContextViewerHost";
import type { ContextPaneState } from "./context-pane-state";
import { DocumentPaneChrome } from "./DocumentPaneChrome";
import { PendingDocumentPath } from "./PendingDocumentPath";
import { RecentDocumentsLanding } from "./RecentDocumentsLanding";
import { RemovedDocumentChip } from "./RemovedDocumentNotice";
import { recentOpening } from "./recent-opening";
import type { IdentityCommitOwnership, IdentityCommitted } from "./use-identity-commit";
import { useRecordOpenedDocument } from "./use-record-opened-document";

function isEditableTab(tab: ContextTab): tab is Extract<ContextTab, { kind: "tracked" | "new" }> {
  return tab.kind === "tracked" || tab.kind === "new";
}

export type ContextViewerProps = {
  projectId: string;
  /** Shell-resolved Editor Work for all reads, suggestions, and mutations. */
  editorWorkId: string | null;
  /** What masks the document body. The tab strip and the address stay outside it. */
  mask: ProjectRouteMask;
  /** The address the Editor was asked for, shown as the path while the body is masked. */
  route: { scheme: ProjectContextTreeScheme; path: string | null } | null;
  onSelectContextPath: (path: string, scheme: ProjectContextTreeScheme) => void;
  /** The Editor's Work, when it has one. */
  editorWork: Work | null;
  tabs: ContextTab[];
  paneState: ContextPaneState;
  onSelectTab: (tab: ContextTab) => void;
  onCloseTab: (tab: ContextTab) => void;
  sidebarToggle?: PaneHeaderRailToggle;
  /**
   * Project right-dock expand toggle (pinned at the tab strip's trailing
   * edge). Same render rule as `sidebarToggle`.
   */
  dockToggle?: PaneHeaderRailToggle;
  /** Whether this persistent surface is currently visible as the active destination. */
  active: boolean;
  layoutSaveFailed?: boolean;
  onNewDocument?: () => void;
  /** Return to the Editor destination's chooser without closing any tab. */
  onShowRecents?: () => void;
  onUntitledBecameNonEmpty: (documentId: string) => Promise<void>;
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string, owner: ContextOwner) => void;
};

export function ContextViewer({
  projectId,
  editorWorkId,
  mask,
  route,
  onSelectContextPath,
  editorWork,
  tabs,
  paneState,
  onSelectTab,
  onCloseTab,
  sidebarToggle,
  dockToggle,
  active,
  onNewDocument,
  onShowRecents,
  layoutSaveFailed = false,
  onUntitledBecameNonEmpty,
  onCommitted,
  onOpenExisting,
}: ContextViewerProps) {
  // Split tabs by kind — TRACKED ones share one warm-set host; viewer tabs
  // mount their own viewer surface for the active one only (heavy
  // renderers + signed URLs don't benefit from pre-mounting).
  const trackedTabs = tabs.filter(isEditableTab);
  const activeTab = paneState.kind === "document" ? paneState.tab : null;
  // Recency is recorded from the tab actually in front of the writer, not from
  // the intent to open. The device record is written in this effect, before the
  // POST; a parked restored tab is not an open.
  const openedDocumentId = activeTab?.documentId ?? null;
  const openedTabRef = useRef(activeTab);
  openedTabRef.current = activeTab;
  const recordOpenedDocument = useRecordOpenedDocument();
  // One open is one record. The effect also re-runs when the recorder's identity
  // changes and when a dev remount replays it; the ref survives both, and clears
  // when the document leaves the front, so reopening it records again.
  const recordedDocumentRef = useRef<string | null>(null);
  useEffect(() => {
    const tab = openedTabRef.current;
    if (!active || !openedDocumentId || tab?.documentId !== openedDocumentId) {
      recordedDocumentRef.current = null;
      return;
    }
    if (recordedDocumentRef.current === openedDocumentId) return;
    const opening = recentOpening(projectId, tab, new Date().toISOString());
    if (!opening) return;
    recordedDocumentRef.current = openedDocumentId;
    recordOpenedDocument(opening);
  }, [active, openedDocumentId, projectId, recordOpenedDocument]);
  const optimisticTab = paneState.kind === "optimistic-loading" ? paneState.tab : null;
  const settledTab = paneState.kind === "optimistic-loading" ? paneState.settledTab : null;
  const activeTabId = (activeTab ?? settledTab)?.documentId ?? null;
  const masked = isProjectRouteMasked(mask);
  const name = activeTab?.name;
  const activeIsEditable = activeTab?.kind === "tracked" || activeTab?.kind === "new";
  // A chat's Scratch belongs to no Work, so archiving the Editor's Work never freezes it.
  const activeFileInWork =
    activeTab &&
    activeTab.kind !== "new" &&
    isWorkScopedScheme(activeTab.scheme) &&
    activeTab.rootThreadId === undefined;

  // Draft review state: the review's controls live in the identity bar.
  const { controller, fileForDocument } = useDraftReview();
  const activeReviewItemKey =
    activeTab &&
    controller.inlineReview?.documentId === activeTab.documentId &&
    controller.inlineReview.shown
      ? controller.inlineReview.itemKey
      : null;
  // A Copy of the tab under review reads the draft as a chat of the Work reads it: the review's own
  // chat when it has one, else the chat that wrote the draft.
  const reviewReader =
    controller.threadId ??
    (activeReviewItemKey && activeTab
      ? fileForDocument(activeTab.documentId)?.draft.actorThreads[0]?.threadId
      : undefined);
  const reviewView: CopyContextEntryView | null = reviewReader
    ? { kind: "draft", workId: controller.workId, threadId: reviewReader }
    : null;
  const archivedEditorWork = editorWork && isWorkArchived(editorWork) ? editorWork : null;
  // Archiving freezes the Editor Work's own files and its drafts (D30). A
  // review edits the draft, so its editor freezes and shows the notice; the
  // reviewed file itself may be project-owned and keeps its identity bar.
  const fileFrozen = Boolean(activeFileInWork && archivedEditorWork);
  const editorFrozen = Boolean((activeFileInWork || activeReviewItemKey) && archivedEditorWork);

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
      role={active ? "main" : undefined}
    >
      {layoutSaveFailed ? (
        <p role="alert" className="px-4 py-2 text-muted-foreground text-sm">
          <Trans>Couldn't save the Editor tab layout. Reload may not restore your tabs.</Trans>
        </p>
      ) : null}
      <ContextTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        activeTabInstanceId={(activeTab ?? settledTab)?.tabInstanceId}
        reviewingTabId={activeReviewItemKey ? activeTabId : null}
        reviewView={reviewView}
        optimisticTab={settledTab ? null : optimisticTab}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onNewDocument={onNewDocument}
        onShowRecents={onShowRecents}
        recentsActive={paneState.kind === "empty-workspace"}
        leading={railToggleNode(sidebarToggle, "left")}
        trailing={railToggleNode(dockToggle, "right")}
        // With no tab left the landing's top margin holds it instead.
        notice={
          tabs.length > 0 ? <RemovedDocumentChip projectId={projectId} surface="editor" /> : null
        }
      />
      {masked && route ? (
        <PendingDocumentPath
          scheme={route.scheme}
          path={route.path}
          onSelectContextPath={onSelectContextPath}
        />
      ) : null}
      <ProjectRouteBoundary {...mask}>
        {/* The page sheet — the lit paper rising out of the L-shaped chrome;
          the center slot's chrome shows in the corner notches. */}
        <PaintHold
          status={name ? t`Opening ${name}` : t`Opening draft`}
          className="page-sheet relative"
        >
          <PaintCapture surface={`${paneState.kind}:${activeTabId ?? optimisticTab?.id ?? ""}`} />
          {activeTab ? (
            <DocumentPaneChrome
              projectId={projectId}
              tab={activeTab}
              archivedWork={editorFrozen ? archivedEditorWork : null}
              onCloseTab={onCloseTab}
              identity={{ editorWorkId, readOnly: fileFrozen, onCommitted, onOpenExisting }}
            />
          ) : null}
          {/* The TRACKED editor host stays mounted while ANY tracked tab is
            open — even when the active tab is a viewer — so the warm-set
            editors aren't torn down on a quick image/PDF detour. We just
            hide the whole host when the active tab isn't tracked. */}
          {trackedTabs.length > 0 ? (
            <PaintScope active={activeIsEditable}>
              <div
                className={
                  activeIsEditable ? "flex min-h-0 flex-1 flex-col" : "pointer-events-none hidden"
                }
              >
                <ContextEditorMountHost
                  projectId={projectId}
                  trackedTabs={trackedTabs}
                  activeTabId={activeIsEditable ? activeTabId : null}
                  active={active}
                  // Warm editors are hidden, so following the front tab is enough.
                  readOnly={editorFrozen}
                  onUntitledBecameNonEmpty={onUntitledBecameNonEmpty}
                />
              </div>
            </PaintScope>
          ) : null}
          {activeTab?.kind === "viewer" ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <ContextViewerHost
                projectId={projectId}
                editorWorkId={editorWorkId}
                tab={activeTab}
              />
            </div>
          ) : null}
          {optimisticTab ? (
            <div className="relative min-h-0 flex-1" aria-busy>
              <DelayedContentSkeleton
                key={JSON.stringify([projectId, optimisticTab.id])}
                className="absolute inset-0"
              />
            </div>
          ) : null}
          {paneState.kind === "empty-workspace" ? (
            <RecentDocumentsLanding
              projectId={projectId}
              editorWorkId={editorWorkId}
              onNewDocument={onNewDocument}
              holdsRemovedNotice={tabs.length === 0}
            />
          ) : null}
          {controller.toast ? (
            <ReviewToast toast={controller.toast} onDismiss={controller.dismissToast} />
          ) : null}
        </PaintHold>
      </ProjectRouteBoundary>
    </div>
  );
}

function railToggleNode(
  toggle: PaneHeaderRailToggle | undefined,
  side: "left" | "right",
): ReactNode {
  if (!toggle || toggle.open) return null;
  const Icon = side === "left" ? PanelLeftOpen : PanelRightOpen;
  return <PanelToggleButton icon={Icon} label={toggle.label} onClick={toggle.onExpand} />;
}

// Re-export the tab-keyed type for callers (notably the controller and
// downstream tests).
export type { ContextTab };
