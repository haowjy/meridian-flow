/**
 * ContextViewer — the Context destination, in ONE component.
 *
 * Purpose: own everything inside the Context center surface as a single
 * cohesive component — the tab strip (project sidebar/dock toggles + open
 * files + active highlight), the FILE TREE (rendered as a left panel below
 * the tab strip, with its own collapse header + internal resize seam), the
 * per-document-type toolbar, the warm-set TRACKED editor host, the
 * read-only viewer host for image/PDF tabs, and the empty placeholder.
 *
 * Key decisions:
 *  - The file tree is NOT a separate grid column. It renders inside this
 *    component, in a horizontal split with the editor area, with width
 *    persistence via its own `context-files-store.ts` (key `meridian:
 *    context-files-panel`), rehydrated behind the project hydration gate.
 *    The shared `ResizeHandle` writes `--context-files-width` on the
 *    split container.
 *  - The tree stays mounted across screen changes because `ContextViewer`
 *    (the center surface) is parked offscreen — not unmounted — when you
 *    leave Context. No reparenting.
 *  - INVARIANT: the files explorer is always re-openable. When the panel
 *    is collapsed, every variant renders a "Show files" reopen button at
 *    the body's top-left.
 *  - Collapse lives on the panel's own header (matching the left sidebar
 *    pattern). The body-toolbar `FilesToggle` is REOPEN-ONLY.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import { type CSSProperties, type ReactNode, useRef } from "react";
import type { ContextTab } from "@/client/stores";
import { ResizeHandle } from "../layout/ResizeHandle";
import type { PaneHeaderRailToggle } from "../shell/PaneHeader";
import { PanelToggleButton } from "../shell/PanelToggleButton";
import { ContextEditorMountHost } from "./ContextEditorMountHost";
import { ContextTabBar } from "./ContextTabBar";
import { ContextTreePanel } from "./ContextTreePanel";
import { ContextViewerHost } from "./ContextViewerHost";
import {
  CONTEXT_FILES_WIDTH_BOUNDS,
  useContextFilesPanel,
  useContextFilesPanelActions,
} from "./context-files-store";
import type { ContextFile } from "./context-tree";
import { documentToolbarVariant, FilesToggle } from "./document-toolbar";

function isEditableTab(tab: ContextTab): tab is Extract<ContextTab, { editable: true }> {
  return tab.editable;
}

/** Clamp bounds for the nested files panel. Owned by context-files-store. */
const FILES_BOUNDS = CONTEXT_FILES_WIDTH_BOUNDS;

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
  /** Active context scheme (for the tree's section auto-expand). */
  activeContextScheme: ProjectContextTreeScheme | null;
  /** Active context path (for the tree's row highlight). */
  activeContextPath: string | null;
  /** Whether this persistent surface is currently visible as the active destination. */
  active: boolean;
  /** Tree row → open as tab. */
  onSelectFile: (scheme: ProjectContextTreeScheme, file: ContextFile) => void;
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
  activeContextScheme,
  activeContextPath,
  active,
  onSelectFile,
}: ContextViewerProps) {
  const splitRef = useRef<HTMLDivElement | null>(null);
  const { width: filesWidth, collapsed: filesCollapsed } = useContextFilesPanel();
  const { setWidth: setFilesWidth, setCollapsed: setFilesCollapsed } =
    useContextFilesPanelActions();
  const filesOpen = !filesCollapsed;
  const onExpandFiles = () => setFilesCollapsed(false);
  const onCollapseFiles = () => setFilesCollapsed(true);
  const onSetFilesWidth = setFilesWidth;
  // Split tabs by kind — TRACKED ones share one warm-set host; viewer tabs
  // mount their own viewer surface for the active one only (heavy
  // renderers + signed URLs don't benefit from pre-mounting).
  const trackedTabs = tabs.filter(isEditableTab);
  const activeTab = tabs.find((candidate) => candidate.documentId === activeTabId) ?? null;
  const activeIsTracked = activeTab?.editable ?? false;
  const variant = documentToolbarVariant(activeTab);

  // The editor (markdown variant) owns its own toolbar; we hand it a
  // REOPEN-ONLY `FilesToggle` so the toolbar only carries the reopen
  // affordance when the files panel is collapsed. Collapse lives on the
  // panel's own header (mirrors the left sidebar's "click without moving
  // the cursor" pattern).
  const editorToolbarLeading =
    variant === "markdown" ? <FilesToggle open={filesOpen} onExpand={onExpandFiles} /> : null;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col bg-background">
      <ContextTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        leading={railToggleNode(sidebarToggle, "left")}
        trailing={railToggleNode(dockToggle, "right")}
      />
      {/* Horizontal split: files panel (left) ⇄ editor / viewer (right).
          The CSS variable is written here so the shared ResizeHandle can
          drive the seam imperatively without re-rendering React on every
          pointermove. */}
      <div
        ref={splitRef}
        className="flex min-h-0 flex-1"
        style={{ "--context-files-width": `${filesWidth}px` } as CSSProperties}
      >
        {filesOpen ? (
          <div
            className="relative shrink-0 border-r border-border bg-surface-subtle"
            style={{ width: "var(--context-files-width)" }}
          >
            <ContextTreePanel
              projectId={projectId}
              activeThreadId={activeThreadId}
              activeScheme={activeContextScheme}
              activePath={activeContextPath}
              onSelectFile={onSelectFile}
              onCollapse={onCollapseFiles}
            />
            {/* Internal resize seam — a zero-width relative strip pinned
                to the panel's right edge so the shared ResizeHandle's
                absolute `left-1/2` pill lands centered on the seam. */}
            <div className="absolute inset-y-0 right-0 z-20 w-0">
              <ResizeHandle
                gridRef={splitRef}
                cssVariableName="--context-files-width"
                widthPx={filesWidth}
                minWidthPx={FILES_BOUNDS.min}
                maxWidthPx={FILES_BOUNDS.max}
                onCommit={onSetFilesWidth}
                ariaLabel={t`Resize files`}
              />
            </div>
          </div>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Viewer / empty variants render their own minimal bar here. The
              markdown variant's formatting bar lives inside `EditorView`
              (it owns the editor instance), so we render nothing for it
              here. */}
          {variant !== "markdown" ? (
            <ViewerEmptyToolbar filesOpen={filesOpen} onExpandFiles={onExpandFiles} />
          ) : null}
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
                toolbarLeading={editorToolbarLeading}
              />
            </div>
          ) : null}
          {activeTab && !activeIsTracked ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <ContextViewerHost
                projectId={projectId}
                activeThreadId={activeThreadId}
                tab={activeTab}
              />
            </div>
          ) : null}
          {!activeTab ? (
            <Placeholder>
              <Trans>Select a document to begin.</Trans>
            </Placeholder>
          ) : null}
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

/**
 * Minimal toolbar rendered by the viewer / empty variants. Per the
 * REOPEN-ONLY `FilesToggle` rule this shows the reopen button when files
 * is collapsed and renders nothing at all when files is open (no chrome
 * distracts from the image/PDF preview or the empty placeholder).
 */
function ViewerEmptyToolbar({
  filesOpen,
  onExpandFiles,
}: {
  filesOpen: boolean;
  onExpandFiles: () => void;
}) {
  if (filesOpen) return null;
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-background px-2 py-1.5">
      <FilesToggle open={filesOpen} onExpand={onExpandFiles} />
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center bg-background px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

// Re-export the tab-keyed type for callers (notably the controller and
// downstream tests).
export type { ContextTab };
