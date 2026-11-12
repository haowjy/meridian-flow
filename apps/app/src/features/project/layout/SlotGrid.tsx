/**
 * SlotGrid renders the desktop project as one flat CSS grid.
 *
 * Every host is a direct child of one grid container for as long as it is mounted, keyed by what
 * it holds. Moving a host between slots changes only its wrapper's grid-area (or parks it
 * offscreen), so a host is never portaled, reparented or remounted by a move. Slot chrome
 * (background, rounding, shadows, borders) is owned by the slot's `className`; this wrapper
 * handles only base layout and the parked state.
 *
 * A host that moves from one slot to another (the panes swapping kinds, by any route) glides from
 * its old rect to its new one (`useGlide`).
 */
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

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
  gridRef: RefObject<HTMLDivElement | null>;
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
  useGlide(gridRef, hosts.map((host) => `${host.key}:${host.slot}`).join());

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

const GLIDE: KeyframeAnimationOptions = { duration: 200, easing: "ease-out" };
/**
 * A document moving between main and the side waits off screen while main's address loads
 * (`DesktopProject`'s kept host): it still glides from where it was if it is back within this.
 */
const PARKED_GLIDE_MS = 1000;

/** A host's layout box in the grid, without the transform a running glide adds. */
type Box = { left: number; top: number; width: number; height: number };
type Placed = { slot: string; box: Box; leftAt?: number };

const boxOf = (host: HTMLElement): Box => ({
  left: host.offsetLeft,
  top: host.offsetTop,
  width: host.offsetWidth,
  height: host.offsetHeight,
});

/**
 * Glides each host whose slot changed from where it was. Only position moves; the host is laid
 * out at its new size from the start and clipped to its old size, so its text never scales. Rects
 * stay current through resizes (a panel drag sets the grid's columns without a render).
 */
function useGlide(grid: RefObject<HTMLDivElement | null>, placement: string) {
  const placed = useRef(new Map<string, Placed>());
  const hostsOf = (node: HTMLDivElement) =>
    node.querySelectorAll<HTMLElement>(":scope > [data-project-host][data-project-slot]");

  useEffect(() => {
    const node = grid.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      for (const host of hostsOf(node)) {
        const key = host.dataset.projectHost ?? "";
        const record = placed.current.get(key);
        if (record) placed.current.set(key, { ...record, box: boxOf(host) });
      }
    });
    observer.observe(node);
    for (const host of hostsOf(node)) observer.observe(host);
    return () => observer.disconnect();
  }, [grid, placement]);

  useLayoutEffect(() => {
    const node = grid.current;
    if (!node) return;
    const motion = matchMedia("(prefers-reduced-motion: no-preference)").matches;
    const now = performance.now();
    const before = placed.current;
    const next = new Map<string, Placed>();
    for (const host of hostsOf(node)) {
      const key = host.dataset.projectHost ?? "";
      const slot = host.dataset.projectSlot ?? "";
      const box = boxOf(host);
      const was = before.get(key);
      const recent = was && (was.leftAt === undefined || now - was.leftAt < PARKED_GLIDE_MS);
      if (motion && recent && was.slot !== slot) glide(host, was.box, box);
      next.set(key, { slot, box });
    }
    for (const [key, was] of before)
      if (!next.has(key) && now - (was.leftAt ?? now) < PARKED_GLIDE_MS)
        next.set(key, { ...was, leftAt: was.leftAt ?? now });
    placed.current = next;
  }, [grid, placement]);
}

function glide(host: HTMLElement, from: Box, to: Box) {
  // The side's slide-in would fade the arriving page; the glide is its entrance.
  for (const running of host.getAnimations()) if (running instanceof CSSAnimation) running.finish();
  const right = Math.max(0, to.width - from.width);
  const bottom = Math.max(0, to.height - from.height);
  host.animate(
    [
      {
        transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`,
        clipPath: `inset(0 ${right}px ${bottom}px 0)`,
      },
      { transform: "none", clipPath: "inset(0)" },
    ],
    GLIDE,
  );
}
