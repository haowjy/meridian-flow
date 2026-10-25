/**
 * A drop target's whole extent: a folder row and every row shown inside it, or
 * an area's header and its list. The lit fill sits behind the rows, inset like
 * them, so their own hover and selected fills still read on top. A refused
 * target stays unlit; the hint beside the pointer says why.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { contextTreeDropTargetClassName } from "../context-row-geometry";
import type { TreeDropState } from "./tree-drop";

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
