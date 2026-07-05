/**
 * PaneTitle — shared title styling for project workspace pane headers.
 *
 * Keeps per-screen pane controllers focused on ownership/rendering while the
 * small typography contract for pane titles stays consistent across Home,
 * Chat, Context, and Settings chrome.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PaneTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("pane-title truncate px-1", className)}>{children}</span>;
}
