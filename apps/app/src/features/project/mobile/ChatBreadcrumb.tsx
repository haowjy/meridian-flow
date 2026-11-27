import { t } from "@lingui/core/macro";

import { ChatThreadTitle } from "@/features/chat/ChatThreadTitle";
import type { ChatDisplay } from "../routing/chat-navigation";
import { MobileBreadcrumb } from "./MobileBreadcrumb";

export function ChatBreadcrumb({
  projectId,
  display,
}: {
  projectId: string;
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
