/**
 * ChatBreadcrumb — the phone's up-level trail for chat: `Chats › <chat>`.
 *
 * The index is the chat's ancestor, so it is reached the phone way (an
 * ancestor crumb, never a back chevron). The current segment stays the chat
 * switcher so switching and New chat remain one tap away. On the index itself
 * the trail is a lone, non-interactive "Chats". The top bar over main's chat only:
 * the chat sheet over a document has no index to climb to. A refused
 * rename spans the width under the top bar (its positioned ancestor), not the
 * narrow trail.
 */
import { t } from "@lingui/core/macro";

import { ChatThreadTitle } from "@/features/chat/ChatThreadTitle";
import { type ChatDisplay, useChatNavigation } from "../routing/chat-navigation";
import { MobileBreadcrumb } from "./MobileBreadcrumb";

export function ChatBreadcrumb({
  projectId,
  display,
}: {
  projectId: string;
  /** Main's chat, or the index. */
  display: ChatDisplay;
}) {
  const { openChatIndex } = useChatNavigation();
  const chats = t`Chats`;
  if (display.kind === "index") return <MobileBreadcrumb segments={[{ label: chats }]} />;
  const current = (
    <ChatThreadTitle
      projectId={projectId}
      threadId={display.threadId}
      failureClassName="inset-x-2"
    />
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
