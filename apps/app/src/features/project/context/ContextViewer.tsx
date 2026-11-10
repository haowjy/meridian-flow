/**
 * Renders the Editor destination and its active document. A file of an
 * archived Work, and a review of its draft, open read-only under the archived
 * notice. The Editor shows only its own Work's files and drafts, so the
 * Editor's Work is that file's Work. Archiving here freezes them at once; the
 * server's own read-only scope follows. A review of a trashed chat's draft
 * opens read-only under the trashed-chat notice, as the server reports it.
 */

import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ContextOwner, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { type ReactNode, useEffect, useRef } from "react";
import { type ContextTab, isDraftOnly } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { InlineErrorRow } from "@/components/app/InlineErrorRow";
import { PaintCapture, PaintHold, PaintScope } from "@/components/app/PaintHold";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { ReviewToast } from "@/features/draft-review/ReviewToast";
import { DocumentStateSlotProvider } from "@/features/editor/document-state-slot";
import {
  isProjectRouteMasked,
  ProjectRouteBoundary,
  type ProjectRouteMask,
} from "../routing/ProjectRouteBoundary";
import type { PaneHeaderRailToggle } from "../shell/PaneHeader";
import { PanelToggleSpacer } from "../shell/PanelToggleButton";
import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ContextTabBar } from "./ContextTabBar";
import { ContextViewerHost } from "./ContextViewerHost";
import type { ContextPaneState } from "./context-pane-state";
import { DocumentIdentityBar } from "./DocumentIdentityBar";
import { DocumentPaneChrome } from "./DocumentPaneChrome";
import { PendingDocumentPath } from "./PendingDocumentPath";
import { RecentDocumentsLanding } from "./RecentDocumentsLanding";
import { RemovedDocumentChip } from "./RemovedDocumentNotice";
import { recentOpening } from "./recent-opening";
import { useDocumentFreeze } from "./use-document-freeze";
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
  const { controller } = useDraftReview();
  const activeReviewItemKey =
    activeTab &&
    controller.inlineReview?.documentId === activeTab.documentId &&
    controller.inlineReview.shown
      ? controller.inlineReview.itemKey
      : null;
  // One freeze source with the dock and the phone: an archived Work freezes its own files and
  // its drafts' reviews; a trashed chat freezes its drafts' reviews. The reviewed file
  // itself may be project-owned, so only its own Work's archive freezes its identity bar.
  const freeze = useDocumentFreeze(
    projectId,
    activeTab,
    activeReviewItemKey ? controller.ownerKey : null,
  );
  const fileFrozen = Boolean(activeFileInWork && freeze?.kind === "work");

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
      role={active ? "main" : undefined}
    >
      {layoutSaveFailed ? (
        <InlineErrorRow
          message={
            <Trans>Couldn't save the Editor tab layout. Reload may not restore your tabs.</Trans>
          }
          wrap
          className="px-4 py-2"
        />
      ) : null}
      <ContextTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        activeTabInstanceId={(activeTab ?? settledTab)?.tabInstanceId}
        optimisticTab={settledTab ? null : optimisticTab}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onNewDocument={onNewDocument}
        onShowRecents={onShowRecents}
        recentsActive={paneState.kind === "empty-workspace"}
        leading={railToggleNode(sidebarToggle, "left")}
        trailing={railToggleNode(dockToggle, "right")}
        // With no tab left the landing's top margin holds it instead.
        notice={tabs.length > 0 ? <RemovedDocumentChip projectId={projectId} /> : null}
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
          <DocumentStateSlotProvider>
            {activeTab ? (
              // Keyed by tab so edit state never crosses tabs.
              <DocumentIdentityBar
                key={activeTab.tabInstanceId ?? activeTab.documentId}
                variant="state"
                projectId={projectId}
                editorWorkId={editorWorkId}
                tab={activeTab}
                readOnly={fileFrozen}
                onCloseDraftOnly={isDraftOnly(activeTab) ? () => onCloseTab(activeTab) : undefined}
                onCommitted={onCommitted}
                onOpenExisting={onOpenExisting}
              />
            ) : null}
            {activeTab ? (
              <DocumentPaneChrome
                projectId={projectId}
                tab={activeTab}
                freeze={freeze}
                reviewNotices
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
                    editorWorkId={editorWorkId}
                    trackedTabs={trackedTabs}
                    activeTabId={activeIsEditable ? activeTabId : null}
                    active={active}
                    // Warm editors are hidden, so following the front tab is enough.
                    readOnly={freeze !== null}
                    onUntitledBecameNonEmpty={onUntitledBecameNonEmpty}
                  />
                </div>
              </PaintScope>
            ) : null}
            {activeTab?.kind === "viewer" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <ContextViewerHost projectId={projectId} tab={activeTab} />
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
          </DocumentStateSlotProvider>
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
  return <PanelToggleSpacer key={side} />;
}

// Re-export the tab-keyed type for callers (notably the controller and
// downstream tests).
export type { ContextTab };
