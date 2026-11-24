import type { SummaryRejectionReason, ThreadId, TurnId, Usage } from "@meridian/contracts/runtime";
import type { ModelResponseReceivedRow } from "@meridian/contracts/threads";
import type { GenerateRequest, Message } from "@meridian-flow/runtime/gateway";
import type { ProjectedActiveHistory } from "../loop/compaction/index.js";

export type SummaryResponse = ModelResponseReceivedRow & {
  usage: Usage;
  meteringStatus?: "missing_usage";
};
export type { SummaryRejectionReason } from "@meridian/contracts/runtime";
export type SummaryOutcome = {
  modelResponses: SummaryResponse[];
  summarizer: { path: "branch" | "rolling"; segments: number };
} & (
  | { kind: "complete"; text: string; model: string }
  | { kind: "failed"; error: unknown; rejectionReason?: SummaryRejectionReason }
  | { kind: "cancelled" }
);
export interface ConversationSummarizer {
  summarize(input: {
    owner: { threadId: ThreadId; turnId: TurnId };
    source: { threadId: ThreadId; throughTurnId?: TurnId };
    instruction: "compaction" | "handoff";
    writerInstructions?: string;
    incomingAgentName?: string;
    changedDocuments?: readonly string[];
    requestInHand: GenerateRequest | null;
    knownTooLarge?: boolean;
    retainedMessages?: readonly Message[];
    projection: ProjectedActiveHistory;
    signal: AbortSignal;
  }): Promise<SummaryOutcome>;
}
