/**
 * HomePaneController — desktop controller for the project Home destination.
 *
 * Owns the Home pane chrome and delegates the leaf content to `HomeScreen`.
 * Route-owned actions are received as callbacks; this controller does not touch
 * navigation or global state directly.
 */
import { Trans } from "@lingui/react/macro";

import { HomeScreen } from "./home/HomeScreen";
import { PaneTitle } from "./PaneTitle";
import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";

export type HomePaneControllerProps = {
  mode?: "home" | "chats";
  projectId: string;
  sidebarToggle: PaneHeaderRailToggle;
  chatToggle: PaneHeaderRailToggle;
  onOpenThread: (threadId: string) => void;
};

export function HomePaneController({
  projectId,
  mode = "home",
  sidebarToggle,
  chatToggle,
  onOpenThread,
}: HomePaneControllerProps) {
  return (
    <main className="main-pane flex min-h-0 flex-1 flex-col">
      <PaneHeader
        title={
          <PaneTitle>{mode === "chats" ? <Trans>Chats</Trans> : <Trans>Home</Trans>}</PaneTitle>
        }
        left={sidebarToggle}
        right={chatToggle}
      />
      <div className="page-sheet min-h-0">
        <HomeScreen projectId={projectId} onOpenThread={onOpenThread} />
      </div>
    </main>
  );
}
