// @ts-nocheck
/**
 * LibraryPaneController — desktop controller for the Library destination.
 *
 * Owns pane chrome (header + rail toggles) and delegates body rendering to
 * `LibraryScreen`. Route-owned navigation stays in the parent project shell.
 * "Test this agent" lives here because it needs the dock's thread-selection
 * path (`onSelectDockThread` — the dock never writes `?thread` itself per the
 * routing invariant) and creates a fresh bound thread per click (capability
 * freeze: an existing thread never picks up edits).
 */
import { Trans } from "@lingui/react/macro";

import { useTestAgent } from "@/features/agents";
import { PaneTitle } from "@/features/project/PaneTitle";
import { PaneHeader, type PaneHeaderRailToggle } from "@/features/project/shell/PaneHeader";

import { LibraryScreen } from "./LibraryScreen";

export type LibraryPaneControllerProps = {
  projectId: string;
  sidebarToggle: PaneHeaderRailToggle;
  chatToggle: PaneHeaderRailToggle;
  /** Dock thread selection from the project shell (sets `?thread`, keeps `?screen`). */
  onSelectDockThread: (threadId: string) => void;
};

export function LibraryPaneController({
  projectId,
  sidebarToggle,
  chatToggle,
  onSelectDockThread,
}: LibraryPaneControllerProps) {
  const { testAgent } = useTestAgent({ projectId, onSelectDockThread });

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
      <LibraryScreen projectId={projectId} onTestAgent={testAgent} />
    </main>
  );
}
