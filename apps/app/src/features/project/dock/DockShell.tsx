/**
 * DockShell — the tabbed container both dock occupants render through.
 *
 * Gives the dock its one header row (view switch + close, via a caller-supplied
 * header slot) and swaps the body between the occupant's native content
 * (`children`) and the work-scoped Changes view. The header only appears in
 * `dock` placement; in `center` the shell is a passthrough so the chat surface
 * can move center↔dock without its live subtree ever reconciling to a
 * different position (the persistent-surface invariant — `children` sits at
 * the same tree depth in both placements).
 *
 * The header is a slot, not a fixed component: the desktop dock renders
 * `DockHeader`, and the phone chat sheet renders its own header built from
 * `MobileTopBar` chrome. `DockShell` owns only the view-switch state
 * (`useDockView`) and hands it to whichever header the caller supplies.
 *
 * The primary body stays MOUNTED when Changes is active: chat must survive a
 * view switch the same way it survives a collapsed dock, so it is hidden and
 * `inert` rather than unmounted. Changes overlays it, so nothing reflows.
 */
import { type ReactNode, useEffect } from "react";

import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { hasDockChanges } from "@/features/chat/docked-drafts";
import { cn } from "@/lib/utils";

import type { ScreenKey } from "../shell/screens";
import { DockChangesView } from "./DockChangesView";
import type { DockHeaderSlotArgs } from "./DockHeader";
import { useDockView, withoutEmptyChanges } from "./dock-view-store";

export type DockShellProps = {
  placement: "center" | "dock";
  screen: ScreenKey;
  /** Renders the dock's header from the current view-switch state; called only in `dock` placement. */
  renderHeader: (args: DockHeaderSlotArgs) => ReactNode;
  children: ReactNode | ((showPrimary: boolean) => ReactNode);
};

export function DockShell({ placement, screen, renderHeader, children }: DockShellProps) {
  const dockView = useDockView(screen);
  const { groups } = useDraftReview();
  const hasChanges = hasDockChanges(groups);
  const { view, views, primaryView } = withoutEmptyChanges(dockView, hasChanges);
  const { setView } = dockView;
  const inDock = placement === "dock";
  const showPrimary = !inDock || view === primaryView;
  const showChanges = inDock && view === "changes";

  useEffect(() => {
    if (!hasChanges && dockView.view === "changes") {
      setView(primaryView);
    }
  }, [dockView.view, hasChanges, primaryView, setView]);

  return (
    <>
      {inDock ? renderHeader({ view, views, onSelectView: setView }) : null}
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
        {showChanges ? <DockChangesView className="absolute inset-0" /> : null}
      </div>
    </>
  );
}
