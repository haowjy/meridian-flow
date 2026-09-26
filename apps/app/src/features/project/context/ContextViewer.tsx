/** Renders the Editor destination and its active document. */
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import type { ContextTab } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { DraftReviewHeader } from "@/features/editor/DraftReviewHeader";
import { PassageNotice } from "@/features/editor/PassageNotice";
import type { PaneHeaderRailToggle } from "../shell/PaneHeader";
import { PanelToggleButton } from "../shell/PanelToggleButton";
import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ContextTabBar } from "./ContextTabBar";
import { ContextViewerHost } from "./ContextViewerHost";
import type { ContextPaneState, MissingDestination } from "./context-pane-state";
import { schemeLabel } from "./context-schemes";
import { DocumentIdentityBar } from "./DocumentIdentityBar";
import { RecentDocumentsLanding } from "./RecentDocumentsLanding";
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
  tabs: ContextTab[];
  paneState: ContextPaneState;
  onSelectTab: (documentId: string) => void;
  onCloseTab: (documentId: string) => void;
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
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
};

export function ContextViewer({
  projectId,
  editorWorkId,
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
  useEffect(() => {
    const tab = openedTabRef.current;
    if (!active || !openedDocumentId || tab?.documentId !== openedDocumentId) return;
    const opening = recentOpening(projectId, tab, new Date().toISOString());
    if (!opening) return;
    recordOpenedDocument(opening);
  }, [active, openedDocumentId, projectId, recordOpenedDocument]);
  const optimisticTab = paneState.kind === "optimistic-loading" ? paneState.tab : null;
  const activeTabId = activeTab?.documentId ?? null;
  const activeIsEditable = activeTab?.kind === "tracked" || activeTab?.kind === "new";

  // Draft review state — the banner sits above the identity bar so review
  // chrome is the first thing the writer sees when entering review mode.
  const { controller } = useDraftReview();
  const activeReviewDraftId =
    activeTab && controller.inlineReview?.documentId === activeTab.documentId
      ? controller.inlineReview.draftId
      : null;

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
        reviewingTabId={activeReviewDraftId ? activeTabId : null}
        optimisticTab={optimisticTab}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onNewDocument={onNewDocument}
        onShowRecents={onShowRecents}
        recentsActive={paneState.kind === "empty-workspace"}
        leading={railToggleNode(sidebarToggle, "left")}
        trailing={railToggleNode(dockToggle, "right")}
      />
      {/* The page sheet — the lit paper rising out of the L-shaped chrome;
          the center slot's chrome shows in the corner notches. */}
      <div className="page-sheet relative">
        {/* A jump that could not find its passage says so here, over the page
            rather than in the layout. */}
        <PassageNotice documentId={activeTabId} />
        {/* Review banner — above the identity bar so it's the first chrome
            the writer sees when entering review mode. */}
        {activeTab && activeReviewDraftId ? (
          <DraftReviewHeader documentId={activeTab.documentId} draftId={activeReviewDraftId} />
        ) : null}
        {/* Identity bar — the top edge of the page every open document
            shares. Keyed by document so edit state never crosses tabs. */}
        {activeTab ? (
          <DocumentIdentityBar
            key={activeTab.documentId}
            projectId={projectId}
            editorWorkId={editorWorkId}
            tab={activeTab}
            onCommitted={onCommitted}
            onOpenExisting={onOpenExisting}
          />
        ) : null}
        {/* The TRACKED editor host stays mounted while ANY tracked tab is
            open — even when the active tab is a viewer — so the warm-set
            editors aren't torn down on a quick image/PDF detour. We just
            hide the whole host when the active tab isn't tracked. */}
        {trackedTabs.length > 0 ? (
          <div
            className={
              activeIsEditable ? "flex min-h-0 flex-1 flex-col" : "pointer-events-none hidden"
            }
          >
            <ContextEditorMountHost
              projectId={projectId}
              workId={editorWorkId}
              trackedTabs={trackedTabs}
              activeTabId={activeIsEditable ? activeTabId : null}
              active={active}
              onUntitledBecameNonEmpty={onUntitledBecameNonEmpty}
            />
          </div>
        ) : null}
        {activeTab?.kind === "viewer" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <ContextViewerHost projectId={projectId} editorWorkId={editorWorkId} tab={activeTab} />
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
        {paneState.kind === "dead-route" ? (
          <MissingDocumentState destination={paneState.destination} />
        ) : null}
        {paneState.kind === "empty-workspace" ? (
          <RecentDocumentsLanding
            projectId={projectId}
            editorWorkId={editorWorkId}
            onNewDocument={onNewDocument}
          />
        ) : null}
        {paneState.kind === "route-error" ? <RouteErrorState /> : null}
      </div>
    </div>
  );
}

/** Where a timeline door lands when its document is gone. */
function MissingDocumentState({ destination }: { destination: MissingDestination }) {
  const section = schemeLabel(destination.scheme);
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="flex max-w-sm flex-col gap-2">
        <p className="font-medium text-prose-foreground">
          <Trans>
            {destination.name} isn't in {section}.
          </Trans>
        </p>
        <p className="text-xs text-muted-foreground">
          <Trans>
            The assistant referred to this document, but it isn't there now. It may have been
            renamed, deleted, or never finished being created.
          </Trans>
        </p>
      </div>
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

function RouteErrorState() {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="flex max-w-sm flex-col gap-2">
        <p className="font-medium text-prose-foreground">
          <Trans>This destination couldn't load.</Trans>
        </p>
        <p className="text-xs text-muted-foreground">
          <Trans>Refresh to try again.</Trans>
        </p>
      </div>
    </div>
  );
}

// Re-export the tab-keyed type for callers (notably the controller and
// downstream tests).
export type { ContextTab };
