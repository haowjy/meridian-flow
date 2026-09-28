/** C7a has no provider-backed brief yet. Its seed protocol can run an injected script. */
import type { ConversationSummarizer } from "../ports/conversation-summarizer.js";
export const pendingHandoffSummarizer: ConversationSummarizer = {
  maxOutputTokens: 0,
  async summarize() {
    return {
      kind: "failed",
      error: new Error("Handoff brief generation is not configured."),
      modelResponses: [],
      summarizer: { path: "cold", segments: 0 },
    };
  },
};
