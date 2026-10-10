/**
 * DockShell — the container both dock occupants render through.
 *
 * Gives the dock its one header row (view switch + close, via a caller-supplied
 * header slot) and swaps the body between the occupant's native content
 * (`children`), the one document the dock
 * can hold (`DockDocumentView`), which covers its native body until closed.
 * The header only appears in
 * `dock` placement; in `center` the shell is a passthrough so the chat surface
 * can move center↔dock without its live subtree ever reconciling to a
 * different position (the persistent-surface invariant — `children` sits at
 * the same tree depth in both placements).
 *
 * The header is a slot, not a fixed component: the desktop dock renders
 * `DockHeader`, and the phone chat sheet renders its own header built from
 * `MobileTopBar` chrome. `DockShell` owns only the view state (`useDockView`)
 * and hands it to whichever header the caller supplies.
 *
 * The primary body stays MOUNTED when a document covers it: chat
 * must survive a view switch the same way it survives a collapsed dock, so it
 * is hidden and `inert` rather than unmounted. The overlay covers it, so
 * nothing reflows.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { usePresentedDockDocument } from "../DesktopProjectController";
import type { ScreenKey } from "../shell/screens";
import { DockDocumentView } from "./DockDocumentView";
import type { DockHeaderSlotArgs } from "./DockHeader";
import { useDockView } from "./dock-view-store";

export type DockShellProps = {
  projectId: string;
  placement: "center" | "dock";
  screen: ScreenKey;
  /** Whether the dock is on screen (not collapsed); a hidden dock's document editor stands down. */
  visible?: boolean;
  /** Renders the dock's header from the current view-switch state; called only in `dock` placement. */
  renderHeader: (args: DockHeaderSlotArgs) => ReactNode;
  children: ReactNode | ((showPrimary: boolean) => ReactNode);
};

export function DockShell({
  projectId,
  placement,
  screen,
  visible = true,
  renderHeader,
  children,
}: DockShellProps) {
  const dockView = useDockView(screen, projectId);
  const { view, views, setView } = dockView;
  const presentedDocument = usePresentedDockDocument(screen);
  const dockDocument = presentedDocument === undefined ? dockView.document : presentedDocument;
  const inDock = placement === "dock";
  const overlay = inDock && dockDocument ? "document" : null;
  const showPrimary = overlay === null;

  return (
    <>
      {inDock
        ? renderHeader({
            projectId,
            view,
            views,
            onSelectView: setView,
            document: dockDocument,
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
        {overlay === "document" && dockDocument ? (
          <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col overflow-hidden">
            <DockDocumentView projectId={projectId} document={dockDocument} visible={visible} />
          </div>
        ) : null}
      </div>
    </>
  );
}
