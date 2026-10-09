/**
 * DockShell — the container both dock occupants render through.
 *
 * Gives the dock its one header row (via a caller-supplied header slot) and, on
 * Work, swaps the body between the occupant's native content (`children`) and
 * the transient Work file view. The header only appears in `dock` placement; in
 * `center` the shell is a passthrough so the chat surface can move center↔dock
 * without its live subtree ever reconciling to a different position (the
 * persistent-surface invariant: `children` sits at the same tree depth in both
 * placements).
 *
 * The header is a slot, not a fixed component: the desktop dock renders
 * `DockHeader`, and the phone chat sheet renders its own header built from
 * `MobileTopBar` chrome. `DockShell` owns only the view state (`useDockView`)
 * and hands it to whichever header the caller supplies.
 *
 * The primary body stays MOUNTED while the file view shows: chat must survive a
 * view switch the same way it survives a collapsed dock, so it is hidden and
 * `inert` rather than unmounted. The file view overlays it, so nothing reflows.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { ScreenKey } from "../shell/screens";
import { DockFileView } from "./DockFileView";
import type { DockHeaderSlotArgs } from "./DockHeader";
import { useDockView } from "./dock-view-store";

export type DockShellProps = {
  projectId: string;
  placement: "center" | "dock";
  screen: ScreenKey;
  /** Renders the dock's header from the current view-switch state; called only in `dock` placement. */
  renderHeader: (args: DockHeaderSlotArgs) => ReactNode;
  children: ReactNode | ((showPrimary: boolean) => ReactNode);
};

export function DockShell({
  projectId,
  placement,
  screen,
  renderHeader,
  children,
}: DockShellProps) {
  const { view, views, setView, file } = useDockView(screen);
  const inDock = placement === "dock";
  const showFile = inDock && view === "file" && screen === "work" && file !== null;
  const showPrimary = !showFile;

  return (
    <>
      {inDock
        ? renderHeader({
            view,
            views,
            onSelectView: setView,
          })
        : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            !showPrimary && "pointer-events-none opacity-0",
          )}
          inert={!showPrimary}
          aria-hidden={!showPrimary}
        >
          {typeof children === "function" ? children(showPrimary) : children}
        </div>
        {showFile && file ? (
          <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden">
            <DockFileView projectId={projectId} file={file} />
          </div>
        ) : null}
      </div>
    </>
  );
}
