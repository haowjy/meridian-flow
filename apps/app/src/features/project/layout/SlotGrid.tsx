/**
 * SlotGrid renders the desktop project as one flat CSS grid.
 *
 * Every host is a direct child of one grid container for as long as it is mounted, keyed by what
 * it holds. Moving a host between slots changes only its wrapper's grid-area (or parks it
 * offscreen), so a host is never portaled, reparented or remounted by a move. Slot chrome
 * (background, rounding, shadows, borders) is owned by the slot's `className`; this wrapper
 * handles only base layout and the parked state.
 */
import { type CSSProperties, type ReactNode, type Ref, useMemo } from "react";

import { cn } from "@/lib/utils";

import type { DesktopProjectSlotId, SlotDefinition } from "./types";

const PARKED_SURFACE_STYLE: CSSProperties = {
  position: "absolute",
  width: 0,
  height: 0,
  overflow: "hidden",
  pointerEvents: "none",
  opacity: 0,
  transform: "translateX(-200vw)",
};

export type SlotGridHost = {
  /** What the host holds: its identity across moves. */
  key: string;
  /** Null parks the host: mounted, off screen. */
  slot: DesktopProjectSlotId | null;
  children: ReactNode;
};

export type SlotGridProps = {
  slots: readonly SlotDefinition[];
  hosts: readonly SlotGridHost[];
  gridTemplateAreas: string;
  gridTemplateColumns: string;
  gridTemplateRows?: string;
  className?: string;
  style?: CSSProperties;
  gridRef?: Ref<HTMLDivElement>;
  children?: ReactNode;
};

export function SlotGrid({
  slots,
  hosts,
  gridTemplateAreas,
  gridTemplateColumns,
  gridTemplateRows = "minmax(0, 1fr)",
  className,
  style,
  gridRef,
  children,
}: SlotGridProps) {
  const slotsById = useMemo(() => new Map(slots.map((slot) => [slot.id, slot])), [slots]);

  return (
    // Hosts are in key order, not place order (see DesktopProject), so Tab would follow ids.
    // reading-flow makes it follow the columns. Chromium only; it also keeps a stale order after an
    // edit inside a host until the grid lays out again. Elsewhere Tab follows key order.
    <div
      ref={gridRef}
      className={cn("grid min-h-0 min-w-0 [reading-flow:grid-rows]", className)}
      style={{
        gridTemplateAreas,
        gridTemplateColumns,
        gridTemplateRows,
        ...style,
      }}
      data-stable-layout-grid
    >
      {hosts.map((host) => {
        const slot = host.slot ? slotsById.get(host.slot) : undefined;
        return (
          <HostWrapper key={host.key} hostKey={host.key} slot={slot}>
            {host.children}
          </HostWrapper>
        );
      })}
      {children}
    </div>
  );
}

function HostWrapper({
  hostKey,
  slot,
  children,
}: {
  hostKey: string;
  slot: SlotDefinition | undefined;
  children: ReactNode;
}) {
  const active = slot !== undefined;
  return (
    <section
      aria-hidden={!active}
      inert={!active}
      className={cn("relative flex min-h-0 min-w-0 flex-col overflow-hidden", slot?.className)}
      style={slot ? { gridArea: slot.area ?? slot.id, ...slot.style } : PARKED_SURFACE_STYLE}
      data-project-host={hostKey}
      data-project-slot={slot?.id}
      data-project-surface-state={active ? "active" : "parked"}
    >
      {children}
    </section>
  );
}
