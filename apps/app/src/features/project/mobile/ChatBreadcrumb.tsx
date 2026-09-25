/**
 * ChatBreadcrumb — the phone's up-level trail for chat: `Chats › <chat>`.
 *
 * The index is the chat's ancestor, so it is reached the phone way (an
 * ancestor crumb, never a back chevron). The current segment stays the chat
 * switcher so switching and New chat remain one tap away. On the index itself
 * the trail is a lone, non-interactive "Chats". The Chat screen's top bar only:
 * the chat sheet over Work or Editor has no index to climb to.
 */
import { t } from "@lingui/core/macro";

import { ChatThreadTitle } from "@/features/chat/ChatThreadHeader";
import {
  type ChatDisplay,
  displayedChatThreadId,
  useChatNavigation,
} from "../routing/chat-navigation";
import { MobileBreadcrumb } from "./MobileBreadcrumb";

export function ChatBreadcrumb({
  projectId,
  display,
}: {
  projectId: string;
  /** Only meaningful on the Chat screen. */
  display: ChatDisplay;
}) {
  const { openChatIndex } = useChatNavigation();
  const chats = t`Chats`;
  if (display.kind === "index") return <MobileBreadcrumb segments={[{ label: chats }]} />;
  const current = (
    <ChatThreadTitle projectId={projectId} threadId={displayedChatThreadId(display)} />
  );
  return (
    <MobileBreadcrumb
      segments={[
        { label: chats, onSelect: () => void openChatIndex(), keep: true },
        { label: t`Chat`, current },
      ]}
    />
  );
}
