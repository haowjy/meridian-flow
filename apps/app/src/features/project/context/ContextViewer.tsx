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
import { DocumentReviewProvider } from "../DocumentReview";
import {
  isProjectRouteMasked,
  ProjectRouteBoundary,
  type ProjectRouteMask,
} from "../routing/ProjectRouteBoundary";
import type { PaneHeaderRailToggle } from "../shell/PaneHeader";
import { PanelToggleSpacer } from "../shell/PanelToggleButton";
import { ContextDocumentHost, type EditableContextTab } from "./ContextDocumentHost";
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
  const chrome = { projectId, editorWorkId, onCloseTab, onCommitted, onOpenExisting };

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
                    trackedTabs={trackedTabs}
                    activeTabId={activeIsEditable ? activeTabId : null}
                    renderTab={(tab, { mountEditor, shown }) => (
                      <DocumentReviewProvider projectId={projectId} tab={tab}>
                        <EditorTabFrame
                          {...chrome}
                          tab={tab}
                          mountEditor={mountEditor}
                          shown={shown}
                          active={active}
                          onUntitledBecameNonEmpty={onUntitledBecameNonEmpty}
                        />
                      </DocumentReviewProvider>
                    )}
                  />
                </div>
              </PaintScope>
            ) : null}
            {activeTab?.kind === "viewer" ? (
              <DocumentReviewProvider projectId={projectId} tab={activeTab}>
                <DocumentChrome {...chrome} tab={activeTab} />
                <div className="flex min-h-0 flex-1 flex-col">
                  <ContextViewerHost projectId={projectId} tab={activeTab} />
                </div>
              </DocumentReviewProvider>
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
          </DocumentStateSlotProvider>
        </PaintHold>
      </ProjectRouteBoundary>
    </div>
  );
}

type ChromeProps = Pick<
  ContextViewerProps,
  "projectId" | "editorWorkId" | "onCloseTab" | "onCommitted" | "onOpenExisting"
>;

/**
 * One Editor tab inside its own review: while shown, its identity row and notices above the
 * editor; always, its host, warm or painted. A file of an archived Work, and a review of its
 * draft, freeze read-only; a trashed chat's draft under review freezes too.
 */
function EditorTabFrame({
  tab,
  mountEditor,
  shown,
  active,
  onUntitledBecameNonEmpty,
  ...chrome
}: ChromeProps & {
  tab: EditableContextTab;
  mountEditor: boolean;
  shown: boolean;
  active: boolean;
  onUntitledBecameNonEmpty: (documentId: string) => Promise<void>;
}) {
  const freeze = useTabFreeze(chrome.projectId, tab);
  return (
    <div className={shown ? "absolute inset-0 flex min-h-0 flex-col" : "hidden"}>
      {shown ? <DocumentChrome {...chrome} tab={tab} /> : null}
      <div className="relative min-h-0 flex-1">
        <ContextDocumentHost
          projectId={chrome.projectId}
          tab={tab}
          mountEditor={mountEditor}
          shown={shown}
          active={active}
          readOnly={freeze !== null}
          onUntitledBecameNonEmpty={onUntitledBecameNonEmpty}
        />
      </div>
    </div>
  );
}

/**
 * One freeze source with the dock and the phone: an archived Work freezes its own files and
 * its drafts' reviews; a trashed chat freezes its drafts' reviews.
 */
function useTabFreeze(projectId: string, tab: ContextTab) {
  const { controller } = useDraftReview();
  const review = controller.inlineReview;
  const reviewing = review?.documentId === tab.documentId && review.shown;
  return useDocumentFreeze(projectId, tab, reviewing ? controller.ownerKey : null);
}

/** The document's identity row, its notices and its review's toast. */
function DocumentChrome({
  projectId,
  editorWorkId,
  tab,
  onCloseTab,
  onCommitted,
  onOpenExisting,
}: ChromeProps & { tab: ContextTab }) {
  const { controller } = useDraftReview();
  const freeze = useTabFreeze(projectId, tab);
  // A chat's Scratch belongs to no Work, so archiving the Editor's Work never freezes it. The
  // reviewed file itself may be project-owned, so only its own Work's archive freezes its
  // identity row.
  const fileInWork =
    tab.kind !== "new" && isWorkScopedScheme(tab.scheme) && tab.rootThreadId === undefined;
  return (
    <>
      {/* Keyed by tab so edit state never crosses tabs. */}
      <DocumentIdentityBar
        key={tab.tabInstanceId ?? tab.documentId}
        variant="state"
        projectId={projectId}
        editorWorkId={editorWorkId}
        tab={tab}
        readOnly={Boolean(fileInWork && freeze?.kind === "work")}
        onCloseDraftOnly={isDraftOnly(tab) ? () => onCloseTab(tab) : undefined}
        onCommitted={onCommitted}
        onOpenExisting={onOpenExisting}
      />
      <DocumentPaneChrome projectId={projectId} tab={tab} freeze={freeze} reviewNotices />
      {controller.toast ? (
        <ReviewToast toast={controller.toast} onDismiss={controller.dismissToast} />
      ) : null}
    </>
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
