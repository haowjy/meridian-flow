/** A request boundary's compaction choice; committed with its selected leaf and inbox batch. */
import type { Block, Turn } from "@meridian/contracts/threads";
import type { GenerateRequest } from "../../gateway/index.js";
import { estimateRequestTokens } from "./estimate.js";
import { type CompactionPlan, planCompaction } from "./plan.js";

export type CompactionDecision =
  | { kind: "generate" }
  | {
      kind: "compact";
      plan: Extract<CompactionPlan, { outcome: "planned" }>;
      requestInHand: GenerateRequest;
      triggerTokens: number;
      tokensBefore: number;
    }
  | { kind: "too_large"; plan: CompactionPlan };

export class CompactionPreparationError extends Error {
  constructor(readonly reason: "context_too_large" | "compaction_failed") {
    super(
      reason === "context_too_large"
        ? "This message is too long for this chat's model."
        : "This conversation couldn't be compacted. Try again.",
    );
  }
}

export function decideCompaction(input: {
  request: GenerateRequest;
  turns: Turn[];
  blocks: Block[];
  thresholdTokens: number | null;
  summaryReserveTokens: number;
  baseline: { inputTokens: number; messageCount: number } | null;
}): CompactionDecision {
  if (input.thresholdTokens === null) return { kind: "generate" };
  const tokensBefore = estimateRequestTokens(input);
  if (tokensBefore < input.thresholdTokens) return { kind: "generate" };
  const plan = planCompaction({
    turns: input.turns,
    blocks: input.blocks,
    triggerTokens: input.thresholdTokens,
    summaryReserveTokens: input.summaryReserveTokens,
    fixedOverheadTokens: estimateRequestTokens({
      request: {
        ...input.request,
        messages: input.request.messages.filter((message) => message.role === "system"),
      },
      baseline: null,
    }),
  });
  return plan.outcome === "planned" && plan.minimalTailFits
    ? {
        kind: "compact",
        plan,
        requestInHand: input.request,
        triggerTokens: input.thresholdTokens,
        tokensBefore,
      }
    : { kind: "too_large", plan };
}
