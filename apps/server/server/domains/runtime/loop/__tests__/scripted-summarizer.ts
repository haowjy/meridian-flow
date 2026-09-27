/** Scripted adapter keeps the real compaction protocol observable without a provider call. */
import type {
  ConversationSummarizer,
  SummaryOutcome,
} from "../../ports/conversation-summarizer.js";
export function scriptedSummarizer(
  script: (
    input: Parameters<ConversationSummarizer["summarize"]>[0],
    call: number,
  ) => Promise<SummaryOutcome> = async () => ({
    kind: "complete",
    text: "Earlier context.",
    model: "summary-model",
    modelResponses: [],
  }),
) {
  const calls: Parameters<ConversationSummarizer["summarize"]>[0][] = [];
  return {
    maxOutputTokens: 100,
    calls,
    async summarize(input: Parameters<ConversationSummarizer["summarize"]>[0]) {
      calls.push(input);
      return script(input, calls.length);
    },
  } satisfies ConversationSummarizer & { calls: typeof calls };
}
