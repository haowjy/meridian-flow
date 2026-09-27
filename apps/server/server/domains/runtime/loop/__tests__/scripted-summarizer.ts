/** Scripted adapter keeps the real compaction protocol observable without a provider call. */
import type {
  ConversationSummarizer,
  SummaryOutcome,
} from "../../ports/conversation-summarizer.js";

type ScriptedOutcome<T = SummaryOutcome> = T extends SummaryOutcome
  ? Omit<T, "summarizer"> & { summarizer?: SummaryOutcome["summarizer"] }
  : never;
export function scriptedSummarizer(
  script: (
    input: Parameters<ConversationSummarizer["summarize"]>[0],
    call: number,
  ) => Promise<ScriptedOutcome> = async () => ({
    kind: "complete",
    text: "Earlier context.",
    model: "summary-model",
    modelResponses: [],
  }),
): ConversationSummarizer & { calls: Parameters<ConversationSummarizer["summarize"]>[0][] } {
  const calls: Parameters<ConversationSummarizer["summarize"]>[0][] = [];
  return {
    maxOutputTokens: 100,
    calls,
    async summarize(input: Parameters<ConversationSummarizer["summarize"]>[0]) {
      calls.push(input);
      return { summarizer: { path: "cold", segments: 1 }, ...(await script(input, calls.length)) };
    },
  };
}
