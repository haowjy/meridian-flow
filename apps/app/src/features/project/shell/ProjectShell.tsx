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
  type SlotDefinition,
  SlotGrid,
  type SlotGridHost,
} from "../layout";
import { DESKTOP_PROJECT_SLOTS, getDesktopGridTemplate } from "../layout/desktop-layout";

export type ProjectShellProps = {
  panels: DesktopPanels;
  hosts: readonly SlotGridHost[];
  onSetSlotWidth: (slot: PanelSlotId, widthPx: number) => void;
  onSetSlotOpen: (slot: PanelSlotId, open: boolean) => void;
  sidebarOver?: boolean;
  children?: ReactNode;
};

export function ProjectShell({
  panels,
  hosts,
  onSetSlotWidth,
  onSetSlotOpen,
  sidebarOver = false,
  children,
}: ProjectShellProps) {
  const gridRef = useRef<HTMLDivElement | null>(null);
  const railOpen = panels["rail-l"].open;
  const sideOpen = panels.side.open;
  const railWidth = panels["rail-l"].width;
  const leftWidth = railOpen && !sidebarOver ? railWidth : 0;
  const sideWidth = sideOpen ? panels.side.width : 0;
  const desktopGridTemplate = getDesktopGridTemplate();

  const toggleRef = useRef({ railOpen, sideOpen, onSetSlotOpen });
  toggleRef.current = { railOpen, sideOpen, onSetSlotOpen };
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
      else current.onSetSlotOpen("side", !current.sideOpen);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SlotGrid
      gridRef={gridRef}
      slots={sidebarOver ? sidebarOverSlots(railWidth) : DESKTOP_PROJECT_SLOTS}
      hosts={hosts}
      className="relative h-full w-full bg-chrome"
      gridTemplateAreas={desktopGridTemplate.areas}
      gridTemplateColumns={desktopGridTemplate.columns}
      gridTemplateRows={desktopGridTemplate.rows}
      style={
        {
          // No rail, no curve: zero the chrome-field corner while no left rail
          // sits beside main; when one does, leave the var unset so the utility's
          // own fallback applies — globals.css is the single owner of the
          // corner radius value.
          "--chrome-corner": leftWidth > 0 ? undefined : "0px",
          "--project-left-width": `${leftWidth}px`,
          "--project-left-handle-width": "0px",
          "--project-side-handle-width": "0px",
          "--project-side-width": `${sideWidth}px`,
        } as CSSProperties
      }
    >
      {children}
      {leftWidth > 0 ? (
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
      {sideOpen ? (
        <div className="relative z-20 min-h-0 overflow-visible" style={{ gridArea: "side-resize" }}>
          <ResizeHandle
            gridRef={gridRef}
            cssVariableName="--project-side-width"
            widthPx={sideWidth}
            minWidthPx={SLOT_WIDTH_BOUNDS.side.min}
            maxWidthPx={SLOT_WIDTH_BOUNDS.side.max}
            measure={() => {
              const half = Math.floor(((gridRef.current?.clientWidth ?? 0) - leftWidth) / 2);
              const { min } = SLOT_WIDTH_BOUNDS.side;
              return { value: Math.min(sideWidth, half), min, max: Math.max(min, half) };
            }}
            onCommit={(px) => onSetSlotWidth("side", px)}
            ariaLabel={t`Resize side panel`}
            dragDirection={-1}
          />
        </div>
      ) : null}
      <CornerToggle
        side="left"
        open={railOpen}
        label={railOpen ? t`Close sidebar  [` : t`Open sidebar  [`}
        onClick={() => onSetSlotOpen("rail-l", !railOpen)}
      />
      <CornerToggle
        side="right"
        open={sideOpen}
        label={sideOpen ? t`Close side panel  ]` : t`Open side panel  ]`}
        onClick={() => onSetSlotOpen("side", !sideOpen)}
      />
    </SlotGrid>
  );
}

function CornerToggle({
  side,
  open,
  label,
  onClick,
}: {
  side: "left" | "right";
  open: boolean;
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
      <Icon aria-hidden />
    </IconButton>
  );
}

function sidebarOverSlots(width: number): SlotDefinition[] {
  return DESKTOP_PROJECT_SLOTS.map((slot) =>
    slot.id === "rail-l"
      ? {
          ...slot,
          area: "center",
          className: cn(slot.className, "z-20 rounded-r-xl shadow-modal"),
          style: { justifySelf: "start", width: `min(${width}px, 100% - 3.5rem)` },
        }
      : slot,
  );
}
