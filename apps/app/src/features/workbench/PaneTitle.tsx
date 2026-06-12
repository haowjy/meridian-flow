// @ts-nocheck
/**
 * PaneTitle — shared title styling for workbench workspace pane headers.
 *
 * Keeps per-screen pane controllers focused on ownership/rendering while the
 * small typography contract for pane titles stays consistent across Home,
 * Chat, Context, and Settings chrome.
 */
import type { ReactNode } from "react";

export function PaneTitle({ children }: { children: ReactNode }) {
  return <span className="pane-title truncate px-1">{children}</span>;
}
