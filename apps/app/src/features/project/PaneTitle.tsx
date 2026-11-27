import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PaneTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("pane-title truncate px-1", className)}>{children}</span>;
}
