/**
 * ContextViewer — the Editor destination's persistent tab strip and document
 * surface. File navigation belongs to the project sidebar.
 */
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { FilePlus, PanelLeftOpen, PanelRightOpen } from "lucide-react";
import type { ReactNode } from "react";
import type { ContextTab } from "@/client/stores";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { DraftReviewHeader } from "@/features/editor/DraftReviewHeader";
import type { PaneHeaderRailToggle } from "../shell/PaneHeader";
import { PanelToggleButton } from "../shell/PanelToggleButton";
import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ContextTabBar } from "./ContextTabBar";
import { ContextViewerHost } from "./ContextViewerHost";
import type { ContextPaneState } from "./context-pane-state";
import { DocumentIdentityBar } from "./DocumentIdentityBar";
import type { IdentityCommitOwnership, IdentityCommitted } from "./use-identity-commit";

function isEditableTab(tab: ContextTab): tab is Extract<ContextTab, { kind: "tracked" | "new" }> {
  return tab.kind === "tracked" || tab.kind === "new";
}

export type ContextViewerProps = {
  projectId: string;
  activeThreadId: string | null;
  /** Active work for work-scoped destinations (Scratch) in identity commits. */
  defaultWorkId: string | null;
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
  /** Last-opened document label, when the project has a remembered route. */
  resumeDocumentName: string | null;
  /** Replay the remembered route through the normal tree-validated open. */
  onResumeDocument: () => void;
  onNewDocument: () => void;
  onUntitledBecameNonEmpty: (documentId: string) => void;
  onCommitted: (
    documentId: string,
    next: IdentityCommitted,
    ownership: IdentityCommitOwnership,
  ) => void;
  onOpenExisting: (scheme: ProjectContextTreeScheme, path: string) => void;
};

/**
 * Desktop tab-aware host. The store (lifted via the workspace controller) is
 * the source of truth for open tabs and the active id; the URL is reconciled
 * in the controller's store→URL effect so it reflects the currently visible
 * tab.
 */
export function ContextViewer({
  projectId,
  activeThreadId,
  defaultWorkId,
  tabs,
  paneState,
  onSelectTab,
  onCloseTab,
  sidebarToggle,
  dockToggle,
  active,
  resumeDocumentName,
  onResumeDocument,
  onNewDocument,
  onUntitledBecameNonEmpty,
  onCommitted,
  onOpenExisting,
}: ContextViewerProps) {
  // Split tabs by kind — TRACKED ones share one warm-set host; viewer tabs
  // mount their own viewer surface for the active one only (heavy
  // renderers + signed URLs don't benefit from pre-mounting).
  const trackedTabs = tabs.filter(isEditableTab);
  const activeTab = paneState.kind === "document" ? paneState.tab : null;
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
      <div className="page-sheet">
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
            activeThreadId={activeThreadId}
            defaultWorkId={defaultWorkId}
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
              trackedTabs={trackedTabs}
              activeTabId={activeIsEditable ? activeTabId : null}
              active={active}
              onUntitledBecameNonEmpty={onUntitledBecameNonEmpty}
            />
          </div>
        ) : null}
        {activeTab?.kind === "viewer" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <ContextViewerHost
              projectId={projectId}
              activeThreadId={activeThreadId}
              tab={activeTab}
            />
          </div>
        ) : null}
        {optimisticTab ? <OptimisticDocumentLoading name={optimisticTab.name} /> : null}
        {paneState.kind === "empty-desk" ||
        paneState.kind === "dead-route" ||
        paneState.kind === "route-error" ? (
          <EditorEmptyState
            resumeDocumentName={resumeDocumentName}
            onResumeDocument={onResumeDocument}
            onNewDocument={onNewDocument}
          />
        ) : null}
      </div>
    </div>
  );
}

function OptimisticDocumentLoading({ name }: { name: string }) {
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-hidden px-8 py-12" role="status">
      <span className="sr-only">
        <Trans>Loading {name}</Trans>
      </span>
      <div aria-hidden className="w-full max-w-2xl space-y-5">
        <Skeleton className="h-7 w-2/5" />
        <div className="space-y-3 pt-3">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-4/5" />
        </div>
        <div className="space-y-3 pt-2">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
        </div>
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

function EditorEmptyState({
  resumeDocumentName,
  onResumeDocument,
  onNewDocument,
}: {
  resumeDocumentName: string | null;
  onResumeDocument: () => void;
  /**
   * Starts a temporary document — the doc has no context location until the
   * writer saves, when the destination picker offers every durable scheme.
   * Deliberately NOT the sidebar inline-create: that flow is scheme-targeted
   * and happens off-pane, which reads as a dead button from the empty state.
   */
  onNewDocument: () => void;
}) {
  return (
    <div className="grid h-full place-items-center px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          {resumeDocumentName ? (
            <Button size="sm" onClick={onResumeDocument}>
              <span className="max-w-56 truncate">
                <Trans>Resume {resumeDocumentName}</Trans>
              </span>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={resumeDocumentName ? "secondary" : "default"}
            onClick={onNewDocument}
          >
            <FilePlus aria-hidden />
            <Trans>New document</Trans>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          <Trans>Or pick a file from the tree.</Trans>
        </p>
      </div>
    </div>
  );
}

// Re-export the tab-keyed type for callers (notably the controller and
// downstream tests).
export type { ContextTab };
