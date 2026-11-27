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
