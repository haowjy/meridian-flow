/** ProjectShell — destination-agnostic desktop layout mechanics. */

import { t } from "@lingui/core/macro";
import { PanelLeft, PanelRight } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef } from "react";

import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import {
  type DesktopPanels,
  type PanelSlotId,
  ResizeHandle,
  SLOT_WIDTH_BOUNDS,
  SlotGrid,
  type SlotGridHost,
} from "../layout";
import { DESKTOP_PROJECT_SLOTS, getDesktopGridTemplate } from "../layout/desktop-layout";

export type ProjectShellProps = {
  /** Whether each panel is open, and its width. */
  panels: DesktopPanels;
  /** Hosts keyed by what they hold, rendered as direct children of the grid container. */
  hosts: readonly SlotGridHost[];
  /** Commit a panel slot's width. */
  onSetSlotWidth: (slot: PanelSlotId, widthPx: number) => void;
  /** Open or close a panel slot. */
  onSetSlotOpen: (slot: PanelSlotId, open: boolean) => void;
  /** A running agent while the side is closed: its toggle carries a spinner. */
  dockActivity?: boolean;
  /** Minimum width (px) the main column may shrink to. */
  mainMinWidth?: number;
  children?: ReactNode;
};

export function ProjectShell({
  panels,
  hosts,
  onSetSlotWidth,
  onSetSlotOpen,
  dockActivity = false,
  mainMinWidth,
  children,
}: ProjectShellProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const railOpen = panels["rail-l"].open;
  const dockOpen = panels.dock.open;
  const leftWidth = railOpen ? panels["rail-l"].width : 0;
  const dockWidth = dockOpen ? panels.dock.width : 0;
  const desktopGridTemplate = getDesktopGridTemplate();

  // `[` toggles the sidebar, `]` the side. Read through a ref so the listener
  // never re-binds while still seeing fresh layout state.
  const toggleRef = useRef({ railOpen, dockOpen, onSetSlotOpen });
  toggleRef.current = { railOpen, dockOpen, onSetSlotOpen };
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
      const current = toggleRef.current;
      e.preventDefault();
      if (e.key === "[") current.onSetSlotOpen("rail-l", !current.railOpen);
      else current.onSetSlotOpen("dock", !current.dockOpen);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SlotGrid
      gridRef={gridRef}
      slots={DESKTOP_PROJECT_SLOTS}
      hosts={hosts}
      // The grid shows only in the center field's rounded top-left notch.
      className="relative h-full w-full bg-chrome"
      gridTemplateAreas={desktopGridTemplate.areas}
      gridTemplateColumns={desktopGridTemplate.columns}
      gridTemplateRows={desktopGridTemplate.rows}
      style={
        {
          // No rail, no curve: zero the chrome-field corner while the left
          // rail is collapsed; when open, leave the var unset so the utility's
          // own fallback applies — globals.css is the single owner of the
          // corner radius value.
          "--chrome-corner": railOpen ? undefined : "0px",
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
      {children}
      {railOpen ? (
        <div className="relative z-20 min-h-0 overflow-visible" style={{ gridArea: "left-resize" }}>
          <ResizeHandle
            gridRef={gridRef}
            cssVariableName="--project-left-width"
            widthPx={leftWidth}
            minWidthPx={SLOT_WIDTH_BOUNDS["rail-l"].min}
            maxWidthPx={SLOT_WIDTH_BOUNDS["rail-l"].max}
            onCommit={(px) => onSetSlotWidth("rail-l", px)}
            ariaLabel={t`Resize sidebar`}
          />
        </div>
      ) : null}
      {dockOpen ? (
        <div className="relative z-20 min-h-0 overflow-visible" style={{ gridArea: "dock-resize" }}>
          <ResizeHandle
            gridRef={gridRef}
            cssVariableName="--project-dock-width"
            widthPx={dockWidth}
            minWidthPx={SLOT_WIDTH_BOUNDS.dock.min}
            maxWidthPx={SLOT_WIDTH_BOUNDS.dock.max}
            onCommit={(px) => onSetSlotWidth("dock", px)}
            ariaLabel={t`Resize side panel`}
            dragDirection={-1}
          />
        </div>
      ) : null}
      {/* The two panel toggles sit at the window's top corners whether their
          panel is open or closed, so closing and reopening never moves the
          pointer. Headers under them keep a PanelToggleSpacer in their place. */}
      <CornerToggle
        side="left"
        open={railOpen}
        label={railOpen ? t`Close sidebar  [` : t`Open sidebar  [`}
        onClick={() => onSetSlotOpen("rail-l", !railOpen)}
      />
      <CornerToggle
        side="right"
        open={dockOpen}
        busy={!dockOpen && dockActivity}
        label={dockOpen ? t`Close side panel  ]` : t`Open side panel  ]`}
        onClick={() => onSetSlotOpen("dock", !dockOpen)}
      />
    </SlotGrid>
  );
}

function CornerToggle({
  side,
  open,
  busy = false,
  label,
  onClick,
}: {
  side: "left" | "right";
  open: boolean;
  busy?: boolean;
  label: string;
  onClick: () => void;
}) {
  const Icon = side === "left" ? PanelLeft : PanelRight;
  return (
    <IconButton
      size="sm"
      label={label}
      aria-expanded={open}
      onClick={onClick}
      data-panel-toggle={side}
      className={cn(
        "absolute top-1 z-30 text-muted-foreground hover:text-foreground",
        side === "left" ? "left-2" : "right-2",
      )}
    >
      <Icon className="size-4" aria-hidden />
      {busy ? <span aria-hidden className="streaming-dot absolute top-1 right-1 size-1.5" /> : null}
    </IconButton>
  );
}
