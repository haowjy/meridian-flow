/**
 * ContextViewer — the Editor destination's persistent tab strip and document
 * surface. File navigation belongs to the project sidebar.
 */
import { Trans } from "@lingui/react/macro";
import { FilePlus, PanelLeftOpen, PanelRightOpen } from "lucide-react";
import type { ReactNode } from "react";
import type { ContextTab, TempDocument } from "@/client/stores";
import { Button } from "@/components/ui/button";
import type { PaneHeaderRailToggle } from "../shell/PaneHeader";
import { PanelToggleButton } from "../shell/PanelToggleButton";
import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ContextTabBar } from "./ContextTabBar";
import { ContextViewerHost } from "./ContextViewerHost";
import { TempDocumentEditor } from "./TempDocumentEditor";

function isEditableTab(tab: ContextTab): tab is Extract<ContextTab, { editable: true }> {
  return tab.editable;
}

export type ContextViewerProps = {
  projectId: string;
  activeThreadId: string | null;
  tabs: ContextTab[];
  activeTabId: string | null;
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
  /** Start the inline manuscript create row in the project sidebar's tree. */
  onNewChapter: () => void;
  tempDocuments: TempDocument[];
  onNewTemp: () => void;
  onTempSaved: (
    scheme: import("@meridian/contracts/protocol").ProjectContextTreeScheme,
    path: string,
  ) => void;
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
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  sidebarToggle,
  dockToggle,
  active,
  resumeDocumentName,
  onResumeDocument,
  onNewChapter,
  tempDocuments,
  onNewTemp,
  onTempSaved,
}: ContextViewerProps) {
  // Split tabs by kind — TRACKED ones share one warm-set host; viewer tabs
  // mount their own viewer surface for the active one only (heavy
  // renderers + signed URLs don't benefit from pre-mounting).
  const trackedTabs = tabs.filter(isEditableTab);
  const activeTab = tabs.find((candidate) => candidate.documentId === activeTabId) ?? null;
  const activeTemp = tempDocuments.find((document) => document.id === activeTabId) ?? null;
  const activeIsTracked = !activeTemp && (activeTab?.editable ?? false);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
      <ContextTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onNewTemp={onNewTemp}
        leading={railToggleNode(sidebarToggle, "left")}
        trailing={railToggleNode(dockToggle, "right")}
        showNewTab={tabs.length === 0}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The TRACKED editor host stays mounted while ANY tracked tab is
            open — even when the active tab is a viewer — so the warm-set
            editors aren't torn down on a quick image/PDF detour. We just
            hide the whole host when the active tab isn't tracked. */}
        {trackedTabs.length > 0 ? (
          <div
            className={
              activeIsTracked ? "flex min-h-0 flex-1 flex-col" : "pointer-events-none hidden"
            }
          >
            <ContextEditorMountHost
              projectId={projectId}
              trackedTabs={trackedTabs}
              activeTabId={activeIsTracked ? activeTabId : null}
              active={active}
            />
          </div>
        ) : null}
        {activeTemp ? (
          <TempDocumentEditor
            projectId={projectId}
            activeThreadId={activeThreadId}
            document={activeTemp}
            onSaved={onTempSaved}
          />
        ) : null}
        {activeTab && !activeIsTracked && !activeTemp ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <ContextViewerHost
              projectId={projectId}
              activeThreadId={activeThreadId}
              tab={activeTab}
            />
          </div>
        ) : null}
        {!activeTab && !activeTemp ? (
          <EditorEmptyState
            resumeDocumentName={resumeDocumentName}
            onResumeDocument={onResumeDocument}
            onNewChapter={onNewChapter}
          />
        ) : null}
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
  onNewChapter,
}: {
  resumeDocumentName: string | null;
  onResumeDocument: () => void;
  onNewChapter: () => void;
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
            onClick={onNewChapter}
          >
            <FilePlus aria-hidden />
            <Trans>New chapter</Trans>
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
