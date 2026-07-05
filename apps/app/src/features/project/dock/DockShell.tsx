/**
 * DockShell — the tabbed container both dock occupants render through.
 *
 * Gives the dock its one header row (view switch + close) and swaps the body
 * between the occupant's native content (`children`) and the work-scoped
 * Changes view. The header only appears in `dock` placement; in `center` the
 * shell is a passthrough so the chat surface can move center↔dock without its
 * live subtree ever reconciling to a different position (the persistent-surface
 * invariant — `children` sits at the same tree depth in both placements).
 *
 * The primary body stays MOUNTED when Changes is active: chat must survive a
 * view switch the same way it survives a collapsed dock, so it is hidden and
 * `inert` rather than unmounted. Changes overlays it, so nothing reflows.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { ScreenKey } from "../shell/screens";
import { DockChangesView } from "./DockChangesView";
import { DockHeader } from "./DockHeader";
import { useDockView } from "./dock-view-store";

export type DockShellProps = {
  /** `center` renders the passthrough; `dock` renders the tabbed header. */
  placement: "center" | "dock";
  /** The active screen — selects the dock view set and its remembered choice. */
  screen: ScreenKey;
  /** Collapse the whole dock (dock placement only). */
  onClose?: () => void;
  /** Chat select/rename dropdown for the left slot when Chat is the view. */
  threadSelect?: ReactNode;
  /** The occupant's native body — always mounted. */
  children: ReactNode;
};

export function DockShell({ placement, screen, onClose, threadSelect, children }: DockShellProps) {
  const { view, views, primaryView, setView } = useDockView(screen);
  const inDock = placement === "dock";
  const showPrimary = !inDock || view === primaryView;
  const showChanges = inDock && view === "changes";

  return (
    <>
      {inDock ? (
        <DockHeader
          view={view}
          views={views}
          onSelectView={setView}
          onClose={onClose}
          threadSelect={threadSelect}
        />
      ) : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            !showPrimary && "pointer-events-none opacity-0",
          )}
          inert={!showPrimary}
          aria-hidden={!showPrimary}
        >
          {children}
        </div>
        {showChanges ? <DockChangesView className="absolute inset-0" /> : null}
      </div>
    </>
  );
}
