/** Test lifecycle and assertion access for the process conversation reveal controller. */

import type { ConversationRevealTarget } from "@/features/chat/conversation-reveal";
import { conversationRevealController } from "@/features/chat/conversation-reveal-controller";

export function abandonConversationReveal(): void {
  conversationRevealController.cancel();
}

export function peekConversationReveal(): ConversationRevealTarget | null {
  return conversationRevealController.target();
}
