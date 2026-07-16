/**
 * ProjectShell — destination-agnostic desktop layout mechanics.
 *
 * Purpose: render one flat grid whose direct children are the persistent surface
 * wrappers, route pane content, and resize handles. Key decision: the shell
 * derives slot occupancy from SurfaceLayoutMap only; moving a surface changes
 * the wrapper grid-area while the surface remains mounted under the same parent.
 * The right dock is one persistent sidebar — its width and collapsed state are
 * shared across screens via slot-level prefs, so dock resize/collapse always go
 * through `onSetDockWidth`/`onSetDockCollapsed`, never the occupant surface's
 * own pref.
 *
 * The file explorer lives in the shared left sidebar; the former `files` grid
 * slot and its dedicated preferences no longer exist.
 */
import { t } from "@lingui/core/macro";
import { type CSSProperties, type ReactNode, type RefObject, useEffect, useRef } from "react";

import {
  type DesktopProjectSlotId,
  occupantOf,
  ResizeHandle,
  SLOT_WIDTH_BOUNDS,
  SlotGrid,
  type SlotGridSurface,
  type SurfaceId,
  type SurfaceLayoutMap,
  type SurfaceWidthBounds,
} from "../layout";
import { DESKTOP_PROJECT_SLOTS, getDesktopGridTemplate } from "../layout/desktop-layout";

export type ProjectShellProps = {
  /** Merged screen placement + persisted prefs for every stable surface. */
  layout: SurfaceLayoutMap;
  /** Stable surfaces rendered once as direct children of the grid container. */
  surfaces: readonly SlotGridSurface[];
  /** Commit a resizable surface width (left rail today). */
  onSetWidth: (surfaceId: SurfaceId, widthPx: number) => void;
  /** Commit a surface collapse/expand preference (non-dock surfaces). */
  onSetCollapsed: (surfaceId: SurfaceId, collapsed: boolean) => void;
  /** Commit the shared dock width. Used by the dock resize handle. */
  onSetDockWidth: (widthPx: number) => void;
  /** Commit the shared dock collapsed state. Used by `]` and the dock close. */
  onSetDockCollapsed: (collapsed: boolean) => void;
  /** Per-surface resize bounds. Only resizable edge surfaces need entries. */
  bounds: SurfaceWidthBounds;
  /** Minimum width (px) the main column may shrink to. */
  mainMinWidth?: number;
  /** Main column content. */
  children: ReactNode;
};

type ToggleTargets = {
  left: SurfaceId | null;
  right: SurfaceId | null;
};

export function ProjectShell({
  layout,
  surfaces,
  onSetWidth,
  onSetCollapsed,
  onSetDockWidth,
  onSetDockCollapsed,
  bounds,
  mainMinWidth,
  children,
}: ProjectShellProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const leftOccupant = visibleOccupantOf(layout, "rail-l");
  const centerOccupant = visibleOccupantOf(layout, "center");
  const dockOccupant = visibleOccupantOf(layout, "dock");
  const leftWidth = leftOccupant ? layout[leftOccupant].width : 0;
  const dockWidth = dockOccupant ? layout[dockOccupant].width : 0;
  // A route pane goes in `center` whenever there is no center surface. Context
  // no longer renders a route pane (the tab strip absorbs
  // the sidebar/dock toggles in-line), so it leaves `routePaneArea` null and
  // the center surface owns the column outright.
  const hasRoutePane = children !== null && children !== undefined && children !== false;
  const routePaneArea: "center" | null = hasRoutePane && !centerOccupant ? "center" : null;
  const desktopGridTemplate = getDesktopGridTemplate();

  // `[` toggles the left surface, `]` toggles the shared dock. Read through a
  // ref so the listener never re-binds while still seeing fresh layout state.
  // The dock toggle goes through onSetDockCollapsed (slot-level pref), not the
  // occupant surface's own pref — that's what makes the dock read as one
  // persistent sidebar across screens.
  const toggleTargetsRef = useRef<ToggleTargets>({ left: null, right: null });
  toggleTargetsRef.current = {
    left: occupantOf(layout, "rail-l"),
    right: occupantOf(layout, "dock"),
  };
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onSetCollapsedRef = useRef(onSetCollapsed);
  onSetCollapsedRef.current = onSetCollapsed;
  const onSetDockCollapsedRef = useRef(onSetDockCollapsed);
  onSetDockCollapsedRef.current = onSetDockCollapsed;
  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
      return target.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "[" && e.key !== "]") return;
      if (isEditableTarget(e.target)) return;
      const { left, right } = toggleTargetsRef.current;
      if (e.key === "[") {
        if (!left) return;
        e.preventDefault();
        onSetCollapsedRef.current(left, !layoutRef.current[left].collapsed);
        return;
      }
      // `]` — drive the shared dock pref directly, regardless of occupant.
      if (!right) return;
      e.preventDefault();
      onSetDockCollapsedRef.current(!layoutRef.current[right].collapsed);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SlotGrid
      gridRef={gridRef}
      slots={DESKTOP_PROJECT_SLOTS}
      layout={layout}
      surfaces={surfaces}
      // bg-shelf: the grid's backdrop matches the shelf — it shows only in the
      // chrome field's rounded top-left notch against the rail.
      className="relative h-full w-full bg-shelf"
      gridTemplateAreas={desktopGridTemplate.areas}
      gridTemplateColumns={desktopGridTemplate.columns}
      gridTemplateRows={desktopGridTemplate.rows}
      style={
        {
          // No rail, no curve: zero the chrome-field corner while the left
          // rail is collapsed; when open, leave the var unset so the utility's
          // own fallback applies — globals.css is the single owner of the
          // corner radius value.
          "--chrome-corner": leftOccupant ? undefined : "0px",
          "--project-left-width": `${leftWidth}px`,
          // Resize handles render as transparent absolute overlays centered on
          // these grid seams; zero-width tracks remove the visible empty strip.
          "--project-left-handle-width": "0px",
          "--project-main-min-width": `${mainMinWidth ?? 0}px`,
          "--project-dock-handle-width": "0px",
          "--project-dock-width": `${dockWidth}px`,
        } as CSSProperties
      }
    >
      {routePaneArea ? (
        <div
          // chrome-field: route panes fill the center cell with
          // no center surface behind them — they must paint exactly what the
          // center slot would (band + rising page-sheet grammar).
          className="chrome-field relative z-0 flex min-h-0 flex-col"
          style={{ gridArea: routePaneArea }}
          data-project-route-pane
        >
          {children}
        </div>
      ) : null}
      {leftOccupant ? (
        <div className="relative z-20 min-h-0 overflow-visible" style={{ gridArea: "left-resize" }}>
          <SurfaceResizeHandle
            gridRef={gridRef}
            cssVariableName="--project-left-width"
            surfaceId={leftOccupant}
            widthPx={leftWidth}
            bounds={bounds}
            onSetWidth={onSetWidth}
            ariaLabel={t`Resize sidebar`}
          />
        </div>
      ) : null}
      {dockOccupant ? (
        <div className="relative z-20 min-h-0 overflow-visible" style={{ gridArea: "dock-resize" }}>
          {/* Dock width is a slot-level pref — drives the shared dock sidebar
              regardless of which surface is currently inside it. */}
          <ResizeHandle
            gridRef={gridRef}
            cssVariableName="--project-dock-width"
            widthPx={dockWidth}
            minWidthPx={SLOT_WIDTH_BOUNDS.dock?.min ?? 280}
            maxWidthPx={SLOT_WIDTH_BOUNDS.dock?.max ?? 520}
            onCommit={onSetDockWidth}
            ariaLabel={t`Resize right rail`}
            dragDirection={-1}
          />
        </div>
      ) : null}
    </SlotGrid>
  );
}

function SurfaceResizeHandle({
  gridRef,
  cssVariableName,
  surfaceId,
  widthPx,
  bounds,
  onSetWidth,
  ariaLabel,
  dragDirection,
  className,
}: {
  gridRef: RefObject<HTMLDivElement | null>;
  cssVariableName: `--${string}`;
  surfaceId: SurfaceId;
  widthPx: number;
  bounds: SurfaceWidthBounds;
  onSetWidth: (surfaceId: SurfaceId, widthPx: number) => void;
  ariaLabel: string;
  dragDirection?: 1 | -1;
  className?: string;
}) {
  const surfaceBounds = bounds[surfaceId];
  if (!surfaceBounds) return null;
  return (
    <ResizeHandle
      gridRef={gridRef}
      cssVariableName={cssVariableName}
      widthPx={widthPx}
      minWidthPx={surfaceBounds.min}
      maxWidthPx={surfaceBounds.max}
      onCommit={(px) => onSetWidth(surfaceId, px)}
      ariaLabel={ariaLabel}
      dragDirection={dragDirection}
      className={className}
    />
  );
}

function visibleOccupantOf(layout: SurfaceLayoutMap, slot: DesktopProjectSlotId): SurfaceId | null {
  const surfaceId = occupantOf(layout, slot);
  if (!surfaceId) return null;
  return layout[surfaceId].collapsed ? null : surfaceId;
}
