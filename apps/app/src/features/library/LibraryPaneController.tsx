// @ts-nocheck
/**
 * LibraryPaneController — desktop controller for the Library destination.
 *
 * Owns pane chrome (header + rail toggles) and delegates body rendering to
 * `LibraryScreen`. Route-owned navigation stays in the parent workbench shell.
 * "Test this agent" lives here because it needs the dock's thread-selection
 * path (`onSelectDockThread` — the dock never writes `?thread` itself per the
 * routing invariant) and creates a fresh bound thread per click (capability
 * freeze: an existing thread never picks up edits).
 */
import { Trans } from "@lingui/react/macro";

import { useTestAgent } from "@/features/agents";
import { PaneTitle } from "@/features/workbench/PaneTitle";
import { PaneHeader, type PaneHeaderRailToggle } from "@/features/workbench/shell/PaneHeader";

import { LibraryScreen } from "./LibraryScreen";

export type LibraryPaneControllerProps = {
  workbenchId: string;
  sidebarToggle: PaneHeaderRailToggle;
  chatToggle: PaneHeaderRailToggle;
  /** Dock thread selection from the workbench shell (sets `?thread`, keeps `?screen`). */
  onSelectDockThread: (threadId: string) => void;
};

export function LibraryPaneController({
  workbenchId,
  sidebarToggle,
  chatToggle,
  onSelectDockThread,
}: LibraryPaneControllerProps) {
  const { testAgent } = useTestAgent({ workbenchId, onSelectDockThread });

  return (
    <main className="main-pane flex min-h-0 flex-1 flex-col">
      <PaneHeader
        title={
          <PaneTitle>
            <Trans>Library</Trans>
          </PaneTitle>
        }
        left={sidebarToggle}
        right={chatToggle}
      />
      <LibraryScreen workbenchId={workbenchId} onTestAgent={testAgent} />
    </main>
  );
}
