/**
 * ContextViewer — the Editor destination's persistent tab strip and document
 * surface. File navigation belongs to the project sidebar.
 */
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { recordRecentDocument } from "@/client/api/recent-documents-api";
import { accountQueryKeys } from "@/client/query/account-query-keys";
import type { ContextTab } from "@/client/stores";
import { DelayedContentSkeleton } from "@/components/app/DelayedContentSkeleton";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { DraftReviewHeader } from "@/features/editor/DraftReviewHeader";
import { PassageNotice } from "@/features/editor/PassageNotice";
import type { PaneHeaderRailToggle } from "../shell/PaneHeader";
import { PanelToggleButton } from "../shell/PanelToggleButton";
import { useAccountId } from "./account-feature-context";
import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ContextTabBar } from "./ContextTabBar";
import { ContextViewerHost } from "./ContextViewerHost";
import type { ContextPaneState, MissingDestination } from "./context-pane-state";
import { schemeLabel } from "./context-schemes";
import { DocumentIdentityBar } from "./DocumentIdentityBar";
import { RecentDocumentsLanding } from "./RecentDocumentsLanding";
import type { IdentityCommitOwnership, IdentityCommitted } from "./use-identity-commit";

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
  /**
   * Project left-sidebar expand toggle (pinned at the tab strip's leading
   * edge). Reuses the `PaneHeader` rail-toggle shape: render the expand
   * button when collapsed, nothing when open (the rail owns its own close).
   */
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
  onUntitledBecameNonEmpty: (documentId: string) => Promise<void>;
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
};

/**
 * Desktop tab-aware host. The store (lifted via the workspace controller) is
 * the source of truth for open tabs; the committed route chooses which one
 * is visible. Screen-entry commands choose a destination before navigating.
 */
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
  // the intent to open: a freshly created document has no row yet, so recording
  // at open time raced document persistence and lost the write.
  const accountId = useAccountId();
  const queryClient = useQueryClient();
  // Any document in front of the writer counts, editable or not (binaries too).
  const openedDocumentId =
    activeTab && (activeTab.kind === "tracked" || activeTab.kind === "viewer")
      ? activeTab.documentId
      : null;
  // Record only while this pane is the active destination: the editor surface
  // stays mounted across destinations, and a restored tab nobody is looking at
  // is not an open. A successful record refreshes the list so a just-opened
  // document is not missing from the landing when the writer returns to it.
  useEffect(() => {
    if (!active || !openedDocumentId) return;
    // Invalidate even if this effect cleans up first: the writer may close the
    // document before the POST settles, and the landing they return to still
    // needs the fresh row. The query client outlives this effect.
    void recordRecentDocument(openedDocumentId, accountId).then((recorded) => {
      if (recorded) {
        void queryClient.invalidateQueries({ queryKey: accountQueryKeys.recentDocumentsRoot });
      }
    });
  }, [active, openedDocumentId, accountId, queryClient]);
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
            onNewDocument={onNewDocument}
            onBrowseTree={sidebarToggle?.open ? undefined : sidebarToggle?.onExpand}
          />
        ) : null}
        {paneState.kind === "route-error" ? <RouteErrorState /> : null}
      </div>
    </div>
  );
}

/**
 * Where a timeline door lands when its document is gone.
 *
 * The timeline deliberately doesn't pre-check existence: that would make the
 * same row clickable or not depending on cache warmth. This pane is the other
 * half of that decision, so it has to be worth landing on. The generic empty
 * workspace read as "nothing here" and offered to start a new document, which is
 * both untrue and the wrong thing to hand someone who was following a
 * reference.
 *
 * One copy covers renames, deletions and documents that never finished being
 * created, because the writer's next move is the same for all three and the
 * pane genuinely cannot tell them apart. No retry: there is nothing to retry.
 */
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

/**
 * Build a `PaneHeader`-style rail toggle for the tab strip's pinned slots.
 * Returns `null` (not an empty element) when the rail is open so the strip
 * skips the padded slot entirely — an always-truthy element here would leave
 * a blank `px-2` box glued to the strip edge and the first tab off-flush.
 */
function railToggleNode(
  toggle: PaneHeaderRailToggle | undefined,
  side: "left" | "right",
): ReactNode {
  if (!toggle || toggle.open) return null;
  const Icon = side === "left" ? PanelLeftOpen : PanelRightOpen;
  return <PanelToggleButton icon={Icon} label={toggle.label} onClick={toggle.onExpand} />;
}

/**
 * Where an Editor route that could not resolve lands. Not the empty state: the
 * writer asked for a specific destination and it failed, so this says so
 * rather than offering to start something new.
 */
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
