// @ts-nocheck
/**
 * MobileChatHost — phone chat wrapper that applies keyboard-aware composer clearance.
 *
 * ChatScreen and ChatView stay shared. The phone shell only adds the
 * visualViewport bridge around them so desktop chat behavior and subscriptions
 * remain unchanged.
 */
import { ChatScreen } from "../chat/ChatScreen";
import { MobileKeyboardAware } from "./MobileKeyboardAware";

export type MobileChatHostProps = {
  workbenchId: string;
  activeThreadId: string | null;
  onSelectThread: (threadId: string) => void;
};

export function MobileChatHost({
  workbenchId,
  activeThreadId,
  onSelectThread,
}: MobileChatHostProps) {
  return (
    <MobileKeyboardAware>
      <ChatScreen
        workbenchId={workbenchId}
        threadId={activeThreadId}
        onSelectThread={onSelectThread}
      />
    </MobileKeyboardAware>
  );
}
