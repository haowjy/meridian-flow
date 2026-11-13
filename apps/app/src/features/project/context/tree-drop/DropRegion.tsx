/**
 * A drop target's whole extent: a folder row and every row shown inside it, or
 * an area's header and its list. The lit fill sits behind the rows, on their
 * edges, so their own hover and selected fills still read on top. A refused
 * target stays unlit; the hint beside the pointer says why. An edge target
 * draws an `InsertionLine` instead of a fill.
 */

import type { ReactNode } from "react";
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";
import type { DropEdge, TreeDropState } from "./tree-drop";

export function DropRegion({
  state,
  flush = false,
  className,
  children,
}: {
  state: TreeDropState;
  /** Inside a list, whose rows reach the region's edges; else the rows sit 8px in. */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("relative isolate", className)}>
      {state === "over" ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0 -z-10 rounded-md",
            flush ? "inset-x-0" : "inset-x-2",
            role.dropTarget,
          )}
        />
      ) : null}
      {children}
    </div>
  );
}

/**
 * Where an edge drop will land: a line on the row's top or bottom border,
 * from the row's indentation (`inset`, in px from the row's box) to its end. Its
 * parent must be positioned; drawn over the row so the boundary reads, never
 * taking pointer input.
 */
export function InsertionLine({ edge, inset }: { edge: DropEdge | null; inset: number }) {
  if (!edge) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute right-0 z-10 h-0.5 rounded-full bg-primary",
        edge === "before" ? "-top-px" : "-bottom-px",
      )}
      style={{ left: inset }}
    />
  );
}
