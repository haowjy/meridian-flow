/** A summary call runs outside delivery locks; every attempted response settles on its placeholder. */
import type { SummaryRejectionReason, ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ModelResponseReceivedRow } from "@meridian/contracts/threads";
import type { GenerateRequest, Message } from "../gateway/index.js";
import type { ProjectedActiveHistory } from "../loop/compaction/index.js";

/** Provider metering data is passed to the shared debit path, not persisted in the row. */
export type SummaryResponse = ModelResponseReceivedRow & { providerData?: unknown };
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
  readonly maxOutputTokens: number;
  /** Never throws after a paid call: every attempted call returns its response row,
   * on success or failure. A throw is an adapter bug. cancelled is legal only
   * when the supplied signal is aborted; provider timeouts are failed.
   */
  summarize(input: {
    owner: { threadId: ThreadId; turnId: TurnId };
    source: { threadId: ThreadId; throughTurnId?: TurnId };
    instruction: "compaction" | "handoff";
    incomingAgentName?: string;
    changedDocuments?: readonly string[];
    requestInHand: GenerateRequest | null;
    /** Overflow means the provider already rejected a request of this size. */
    knownTooLarge?: boolean;
    /** Warm compaction exclusions, rendered from the plan's retained pin/tail slices. */
    retainedMessages?: readonly Message[];
    /** Cold source: only the cut (excluding the retained pin/tail), plus prior summary context. */
    projection: ProjectedActiveHistory;
    signal: AbortSignal;
  }): Promise<SummaryOutcome>;
}
