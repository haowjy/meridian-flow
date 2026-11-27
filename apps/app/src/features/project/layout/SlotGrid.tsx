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

/**
 * A parked host keeps the size of the slot it left and skips its subtree's layout and paint
 * (`content-visibility: hidden` keeps the rendering state, so the reveal lays out once). At zero
 * width a kept document or chat would re-lay out every word on each edit or streamed token.
 */
const PARKED_SURFACE_STYLE: CSSProperties = {
  position: "absolute",
  overflow: "hidden",
  pointerEvents: "none",
  opacity: 0,
  transform: "translateX(-200vw)",
  contentVisibility: "hidden",
};

export type SlotGridHost = {
  key: string;
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
  const sizes = useGlide(gridRef, hosts.map((host) => `${host.key}:${host.slot}`).join());

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
          <HostWrapper
            key={host.key}
            hostKey={host.key}
            slot={slot}
            parkedSize={sizes.current.get(host.key)}
          >
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
  parkedSize,
  children,
}: {
  hostKey: string;
  slot: SlotDefinition | undefined;
  parkedSize: Size | undefined;
  children: ReactNode;
}) {
  const active = slot !== undefined;
  return (
    <section
      aria-hidden={!active}
      inert={!active}
      className={cn("relative flex min-h-0 min-w-0 flex-col overflow-hidden", slot?.className)}
      style={
        slot
          ? { gridArea: slot.area ?? slot.id, ...slot.style }
          : { ...PARKED_SURFACE_STYLE, ...parkedSize }
      }
      data-project-host={hostKey}
      data-project-slot={slot?.id}
      data-project-surface-state={active ? "active" : "parked"}
    >
      {children}
    </section>
  );
}

const GLIDE: KeyframeAnimationOptions = { duration: 200, easing: "ease-out" };
const PARKED_GLIDE_MS = 1000;

type Box = { left: number; top: number; width: number; height: number };
type Size = { width: number; height: number };
type Placed = { slot: string; box: Box; leftAt?: number };

const boxOf = (host: HTMLElement): Box => ({
  left: host.offsetLeft,
  top: host.offsetTop,
  width: host.offsetWidth,
  height: host.offsetHeight,
});

function useGlide(grid: RefObject<HTMLDivElement | null>, placement: string) {
  const placed = useRef(new Map<string, Placed>());
  const sizes = useRef(new Map<string, Size>());
  const hostsOf = (node: HTMLDivElement) =>
    node.querySelectorAll<HTMLElement>(":scope > [data-project-host][data-project-slot]");

  useEffect(() => {
    const node = grid.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      for (const host of hostsOf(node)) {
        const key = host.dataset.projectHost ?? "";
        const box = boxOf(host);
        sizes.current.set(key, { width: box.width, height: box.height });
        const record = placed.current.get(key);
        if (record) placed.current.set(key, { ...record, box });
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
  return sizes;
}

function glide(host: HTMLElement, from: Box, to: Box) {
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
