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
import { MobileBreadcrumb } from "./MobileBreadcrumb";

export function ChatBreadcrumb({
  projectId,
  threadId,
  index,
  onOpenIndex,
  onSelectThread,
}: {
  projectId: string;
  threadId: string | null;
  /** The index is showing: the trail ends at "Chats". */
  index: boolean;
  onOpenIndex?: () => void;
  onSelectThread: (threadId: string) => void;
}) {
  const chats = t`Chats`;
  if (index) return <MobileBreadcrumb segments={[{ label: chats }]} />;
  const current = (
    <ChatThreadTitle projectId={projectId} threadId={threadId} onSelectThread={onSelectThread} />
  );
  return (
    <MobileBreadcrumb
      segments={[
        { label: chats, onSelect: onOpenIndex, keep: true },
        { label: t`Chat`, current },
      ]}
    />
  );
}
