/**
 * MobileChatHost — phone chat wrapper that applies keyboard-aware composer clearance.
 *
 * ChatScreen and ChatView stay shared. The phone shell only adds the
 * visualViewport bridge around them so desktop chat behavior and subscriptions
 * remain unchanged.
 */
import type { Work } from "@meridian/contracts/protocol";
import { ChatScreen } from "../chat/ChatScreen";
import type { ContextRouteTarget } from "../routing/project-route";
import { MobileKeyboardAware } from "./MobileKeyboardAware";

export type MobileChatHostProps = {
  projectId: string;
  threadId: string | null;
  activeWork: Work | null;
  availableWorks: readonly Work[];
  onSelectThread: (threadId: string) => void;
  onOpenContextTarget?: (target: ContextRouteTarget) => void;
};

export function MobileChatHost({
  projectId,
  threadId,
  activeWork,
  availableWorks,
  onSelectThread,
  onOpenContextTarget,
}: MobileChatHostProps) {
  return (
    <MobileKeyboardAware>
      <ChatScreen
        projectId={projectId}
        threadId={threadId}
        activeWork={activeWork}
        availableWorks={availableWorks}
        onSelectThread={onSelectThread}
        onOpenContextTarget={onOpenContextTarget}
      />
    </MobileKeyboardAware>
  );
}
