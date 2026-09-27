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

import { Trans } from "@lingui/react/macro";
import { type ReactNode, useEffect } from "react";
import type { ContextTab } from "@/client/stores";
import { Button } from "@/components/ui/button";

import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { hasDockChanges } from "@/features/chat/docked-drafts";
import { cn } from "@/lib/utils";
import { ContextViewerBareHost } from "../context/ContextViewerHost";

import type { ScreenKey } from "../shell/screens";
import { DockChangesView } from "./DockChangesView";
import type { DockHeaderSlotArgs } from "./DockHeader";
import { useDockView, withoutEmptyChanges } from "./dock-view-store";

export type DockShellProps = {
  projectId: string;
  placement: "center" | "dock";
  screen: ScreenKey;
  /** Renders the dock's header from the current view-switch state; called only in `dock` placement. */
  renderHeader: (args: DockHeaderSlotArgs) => ReactNode;
  onOpenFileInEditor?: (tab: Extract<ContextTab, { kind: "viewer" }>) => void;
  children: ReactNode | ((showPrimary: boolean) => ReactNode);
};

export function DockShell({
  projectId,
  placement,
  screen,
  renderHeader,
  onOpenFileInEditor,
  children,
}: DockShellProps) {
  const dockView = useDockView(screen);
  const { groups } = useDraftReview();
  const hasChanges = hasDockChanges(groups);
  const { view, views, primaryView } = withoutEmptyChanges(dockView, hasChanges);
  const { setView, file, closeFile } = dockView;
  const inDock = placement === "dock";
  const showPrimary = !inDock || view === primaryView || view === "chat";
  const showFile = inDock && screen === "work" && view === "file" && file !== null;
  const showChanges = inDock && view === "changes";

  useEffect(() => {
    if (!hasChanges && dockView.view === "changes") {
      setView(primaryView);
    }
  }, [dockView.view, hasChanges, primaryView, setView]);

  return (
    <>
      {inDock
        ? renderHeader({
            view,
            views,
            onSelectView: setView,
            fileTab: file?.tab,
            onCloseFile: closeFile,
          })
        : null}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            (!showPrimary || showFile) && "pointer-events-none opacity-0",
          )}
          inert={!showPrimary || showFile}
          aria-hidden={!showPrimary || showFile}
        >
          {typeof children === "function" ? children(showPrimary) : children}
        </div>
        {showChanges ? <DockChangesView className="absolute inset-0" /> : null}
        {showFile && file ? (
          <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden">
            <ContextViewerBareHost
              projectId={projectId}
              editorWorkId={file.workId}
              tab={file.tab}
              header={{
                location: {
                  name: file.tab.scheme === "scratch" ? "Scratch" : "Uploads",
                  ...(file.tab.path.split("/").filter(Boolean).length > 1
                    ? {
                        folder: file.tab.path.split("/").filter(Boolean).slice(0, -1).join(", "),
                      }
                    : {}),
                },
                action: onOpenFileInEditor ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      closeFile();
                      onOpenFileInEditor(file.tab);
                    }}
                  >
                    <Trans>Open in Editor</Trans>
                  </Button>
                ) : undefined,
              }}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}
