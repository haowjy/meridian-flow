/**
 * A drop target's whole extent: a folder row and every row shown inside it, or
 * an area's header and its list. The lit fill sits behind the rows, inset like
 * them, so their own hover and selected fills still read on top. A refused
 * target stays unlit; the hint beside the pointer says why. An edge target
 * draws an `InsertionLine` instead of a fill.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { contextTreeDropTargetClassName } from "../context-row-geometry";
import type { DropEdge, TreeDropState } from "./tree-drop";

export function DropRegion({
  state,
  className,
  children,
}: {
  state: TreeDropState;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("relative isolate", className)}>
      {state === "over" ? (
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-2 inset-y-0 -z-10 rounded-md",
            contextTreeDropTargetClassName,
          )}
        />
      ) : null}
      {children}
    </div>
  );
}

/**
 * Where an edge drop will land: a line on the row's top or bottom border,
 * starting at the row's indentation (`inset`, in px from the row's box). Its
 * parent must be positioned; drawn over the row so the boundary reads, never
 * taking pointer input.
 */
export function InsertionLine({ edge, inset }: { edge: DropEdge | null; inset: number }) {
  if (!edge) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute right-2 z-10 h-0.5 rounded-full bg-primary",
        edge === "before" ? "-top-px" : "-bottom-px",
      )}
      style={{ left: inset }}
    />
  );
}
