/**
 * ChatBreadcrumb — the phone's title for main's chat: the chat switcher, so switching and New
 * chat stay one tap away, and renaming. A refused rename spans the width under the top bar (its
 * positioned ancestor), not the narrow trail.
 */
import { t } from "@lingui/core/macro";

import { ChatThreadTitle } from "@/features/chat/ChatThreadTitle";
import type { ChatDisplay } from "../routing/chat-navigation";
import { MobileBreadcrumb } from "./MobileBreadcrumb";

export function ChatBreadcrumb({
  projectId,
  display,
}: {
  projectId: string;
  /** Main's chat, a new chat, or Recent chats. */
  display: ChatDisplay;
}) {
  if (display.kind === "chat-recents")
    return <MobileBreadcrumb segments={[{ label: t`Chat` }, { label: t`Recent chats` }]} />;
  const current = (
    <ChatThreadTitle
      projectId={projectId}
      threadId={display.kind === "thread" ? display.threadId : null}
      failureClassName="inset-x-2"
    />
  );
  return <MobileBreadcrumb segments={[{ label: t`Chat`, current }]} />;
}
