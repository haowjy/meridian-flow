/** A summary call runs outside delivery locks; every attempted response settles on its placeholder. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ModelResponseReceivedRow } from "@meridian/contracts/threads";
import type { GenerateRequest } from "../gateway/index.js";
import type { ProjectedActiveHistory } from "../loop/compaction/index.js";

export type SummaryOutcome = {
  modelResponses: ModelResponseReceivedRow[];
} & (
  | { kind: "complete"; text: string; model: string }
  | { kind: "failed"; error: unknown }
  | { kind: "cancelled" }
);
export interface ConversationSummarizer {
  readonly maxOutputTokens: number;
  summarize(input: {
    threadId: ThreadId;
    turnId: TurnId;
    instruction: "compaction" | "handoff_brief";
    requestInHand: GenerateRequest | null;
    projection: ProjectedActiveHistory;
    signal: AbortSignal;
  }): Promise<SummaryOutcome>;
}
