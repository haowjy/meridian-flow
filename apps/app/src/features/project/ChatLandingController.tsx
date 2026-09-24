/** Project Chat landing pane chrome and feed composition. */
import { Trans } from "@lingui/react/macro";

import { ChatLandingScreen } from "./chat-landing/ChatLandingScreen";
import { PaneTitle } from "./PaneTitle";
import { PaneHeader, type PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ChatLandingControllerProps = {
  projectId: string;
  sidebarToggle: PaneHeaderRailToggle;
  chatToggle: PaneHeaderRailToggle;
  onOpenThread: (threadId: string) => void;
};

export function ChatLandingController({
  projectId,
  sidebarToggle,
  chatToggle,
  onOpenThread,
}: ChatLandingControllerProps) {
  return (
    <main className="main-pane flex min-h-0 flex-1 flex-col">
      <PaneHeader
        title={
          <PaneTitle>
            <Trans>Chat</Trans>
          </PaneTitle>
        }
        left={sidebarToggle}
        right={chatToggle}
      />
      <div className="page-sheet min-h-0">
        <ChatLandingScreen projectId={projectId} onOpenThread={onOpenThread} />
      </div>
    </main>
  );
}
