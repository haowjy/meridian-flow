/**
 * MobileChatHost — phone chat wrapper that applies keyboard-aware composer clearance.
 *
 * ChatScreen and ChatView stay shared. The phone shell only adds the
 * visualViewport bridge around them so desktop chat behavior and subscriptions
 * remain unchanged.
 */
import type { ProjectContextTreeScheme, Work } from "@meridian/contracts/protocol";
import type { OpenAcknowledgementTransfer } from "@/client/query/visible-thread-open-acknowledgements";
import { ChatScreen } from "../chat/ChatScreen";
import { MobileKeyboardAware } from "./MobileKeyboardAware";

export type MobileChatHostProps = {
  projectId: string;
  threadId: string | null;
  activeWork: Work | null;
  onSelectThread: (threadId: string) => void;
  onSelectContextPath?: (path: string, scheme?: ProjectContextTreeScheme) => void;
  openTransfer?: OpenAcknowledgementTransfer;
  onOpenTransferClaimed?: (transfer: OpenAcknowledgementTransfer) => void;
};

export function MobileChatHost({
  projectId,
  threadId,
  activeWork,
  onSelectThread,
  onSelectContextPath,
  openTransfer,
  onOpenTransferClaimed,
}: MobileChatHostProps) {
  return (
    <MobileKeyboardAware>
      <ChatScreen
        projectId={projectId}
        threadId={threadId}
        activeWork={activeWork}
        onSelectThread={onSelectThread}
        onSelectContextPath={onSelectContextPath}
        visible
        openTransfer={openTransfer}
        onOpenTransferClaimed={onOpenTransferClaimed}
      />
    </MobileKeyboardAware>
  );
}
