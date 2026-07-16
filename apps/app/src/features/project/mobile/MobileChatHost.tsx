/**
 * MobileChatHost — phone chat wrapper that applies keyboard-aware composer clearance.
 *
 * ChatScreen and ChatView stay shared. The phone shell only adds the
 * visualViewport bridge around them so desktop chat behavior and subscriptions
 * remain unchanged.
 */
import type { ProjectContextTreeScheme, Work } from "@meridian/contracts/protocol";
import { ChatScreen } from "../chat/ChatScreen";
import { MobileKeyboardAware } from "./MobileKeyboardAware";

export type MobileChatHostProps = {
  projectId: string;
  activeThreadId: string | null;
  activeWork: Work | null;
  onSelectThread: (threadId: string) => void;
  onSelectContextPath?: (path: string, scheme?: ProjectContextTreeScheme) => void;
};

export function MobileChatHost({
  projectId,
  activeThreadId,
  activeWork,
  onSelectThread,
  onSelectContextPath,
}: MobileChatHostProps) {
  return (
    <MobileKeyboardAware>
      <ChatScreen
        projectId={projectId}
        threadId={activeThreadId}
        activeWork={activeWork}
        onSelectThread={onSelectThread}
        onSelectContextPath={onSelectContextPath}
      />
    </MobileKeyboardAware>
  );
}
