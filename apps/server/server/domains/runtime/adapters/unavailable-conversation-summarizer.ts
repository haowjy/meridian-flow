import type { ConversationSummarizer } from "../ports/conversation-summarizer.js";

/** C4d supplies the real adapter. No default trigger is enabled before then. */
export const unavailableConversationSummarizer: ConversationSummarizer = {
  maxOutputTokens: 4096,
  async summarize() {
    throw new Error("Conversation summarizer is not configured");
  },
};
