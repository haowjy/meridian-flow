// @ts-nocheck
/**
 * SlotGrid renders the desktop workbench as one flat CSS grid.
 *
 * Purpose: keep every stateful surface mounted as a direct child of one grid
 * container for the whole session. Key decision: placement changes only mutate
 * the surface wrapper's grid-area (or park it offscreen when inactive); surfaces
 * are never portaled, reparented, or conditionally removed by screen changes.
 * Slot chrome (background, rounding, shadows, borders) is fully owned by the
 * slot's `className` — this wrapper only handles base layout + parked state.
 */
import { type CSSProperties, type ReactNode, type Ref, useMemo } from "react";

import { cn } from "@/lib/utils";

import type { SlotDefinition, SurfaceId, SurfaceLayoutMap } from "./types";

const PARKED_SURFACE_STYLE: CSSProperties = {
  position: "absolute",
  width: 0,
  height: 0,
  overflow: "hidden",
  pointerEvents: "none",
  opacity: 0,
  transform: "translateX(-200vw)",
};

export type SlotGridSurface = {
  id: SurfaceId;
  children: ReactNode;
};

export type SlotGridProps = {
  slots: readonly SlotDefinition[];
  layout: SurfaceLayoutMap;
  surfaces: readonly SlotGridSurface[];
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
  layout,
  surfaces,
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
    <div
      ref={gridRef}
      className={cn("grid min-h-0 min-w-0", className)}
      style={{
        gridTemplateAreas,
        gridTemplateColumns,
        gridTemplateRows,
        ...style,
      }}
      data-stable-layout-grid
    >
      {surfaces.map((surface) => {
        const surfaceLayout = layout[surface.id];
        const slot =
          surfaceLayout.slot !== null && !surfaceLayout.collapsed
            ? slotsById.get(surfaceLayout.slot)
            : undefined;
        const active = Boolean(slot);
        return (
          <SurfaceWrapper key={surface.id} surfaceId={surface.id} slot={slot} active={active}>
            {surface.children}
          </SurfaceWrapper>
        );
      })}
      {children}
    </div>
  );
}

function SurfaceWrapper({
  surfaceId,
  slot,
  active,
  children,
}: {
  surfaceId: SurfaceId;
  slot: SlotDefinition | undefined;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-hidden={!active}
      inert={!active}
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
        active && slot?.className,
      )}
      style={
        active && slot
          ? {
              gridArea: slot.area ?? slot.id,
              ...slot.style,
            }
          : PARKED_SURFACE_STYLE
      }
      data-workbench-surface={surfaceId}
      data-workbench-slot={active ? slot?.id : undefined}
      data-workbench-surface-state={active ? "active" : "parked"}
    >
      {children}
    </section>
  );
}
