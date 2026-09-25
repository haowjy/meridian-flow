/** The route resolves chat identity once; descendants must never re-derive it from a primary list. */
import type { CurrentChat } from "@/client/working-set";

export function resolveChatThreadId(
  explicitThreadId: string | null,
  currentChat: CurrentChat,
): string | null {
  return explicitThreadId ?? (currentChat.kind === "thread" ? currentChat.threadId : null);
}
