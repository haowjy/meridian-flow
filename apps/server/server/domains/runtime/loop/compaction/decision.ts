/** A request boundary's compaction choice; committed with its selected leaf and inbox batch. */
import type { Block, Turn } from "@meridian/contracts/threads";
import type { GenerateRequest, TokenizerFamily } from "../../gateway/index.js";
import { estimateRequestTokens } from "./estimate.js";
import { type CompactionPlan, planCompaction } from "./plan.js";

/** A boundary-owned forced preparation, never a replacement for its prepare callback. */
export interface ForcedCompactionDecision {
  kind: "compact";
  trigger: "auto" | "manual";
  fitLimitTokens: number;
  path?: "cold";
}
export type CompactionDecision =
  | { kind: "generate" }
  | {
      kind: "compact";
      plan: CompactionPlan;
      controlMessageId?: string;
      satisfiesControlId?: string;
      refusal?: "nothing_to_compact" | "context_too_large";
      required: boolean;
      requestInHand: GenerateRequest;
      trigger: "auto" | "manual";
      fitLimitTokens: number;
      tokensBefore: number;
      path?: "cold";
    }
  | { kind: "too_large"; plan: CompactionPlan };

export class CompactionPreparationError extends Error {
  constructor(
    readonly reason:
      | "nothing_to_compact"
      | "context_too_large"
      | "compaction_failed"
      | "context_window_exceeded",
  ) {
    super(
      reason === "nothing_to_compact"
        ? "There is nothing to compact yet."
        : reason === "context_too_large"
          ? "This message is too long for this chat's model."
          : reason === "context_window_exceeded"
            ? "This conversation still exceeds the model's context window after compaction. Try a smaller request."
            : "This conversation couldn't be compacted. Try again.",
    );
  }
}

export function decideCompaction(input: {
  request: GenerateRequest;
  turns: Turn[];
  blocks: Block[];
  thresholdTokens: number | null;
  forcedDecision?: ForcedCompactionDecision;
  pinnedRequestTurnIds?: ReadonlySet<string>;
  controlMessageId?: string;
  summaryReserveTokens: number;
  baseline: { inputTokens: number; messageCount: number } | null;
  tokenizer: TokenizerFamily;
}): CompactionDecision {
  const fitLimitTokens = input.forcedDecision?.fitLimitTokens ?? input.thresholdTokens;
  if (fitLimitTokens === null) return { kind: "generate" };
  const tokensBefore = estimateRequestTokens(input);
  if (!input.forcedDecision && tokensBefore < fitLimitTokens) return { kind: "generate" };
  const plan = planCompaction({
    turns: input.turns,
    blocks: input.blocks,
    fitLimitTokens,
    tailBudgetBaseTokens:
      input.forcedDecision?.trigger === "manual"
        ? Math.min(input.thresholdTokens ?? fitLimitTokens, tokensBefore)
        : fitLimitTokens,
    pinnedRequestTurnIds: input.pinnedRequestTurnIds,
    summaryReserveTokens: input.summaryReserveTokens,
    fixedOverheadTokens: estimateRequestTokens({
      tokenizer: input.tokenizer,
      request: {
        ...input.request,
        messages: input.request.messages.filter((message) => message.role === "system"),
      },
      baseline: null,
    }),
    tokenizer: input.tokenizer,
  });
  return input.forcedDecision?.trigger === "manual" ||
    (plan.outcome === "planned" && plan.minimalTailFits)
    ? {
        kind: "compact",
        plan,
        requestInHand: input.request,
        trigger: input.forcedDecision?.trigger ?? "auto",
        fitLimitTokens,
        ...(input.forcedDecision ? { path: input.forcedDecision.path } : {}),
        tokensBefore,
        required:
          input.forcedDecision?.trigger !== "manual" ||
          (input.thresholdTokens !== null && tokensBefore >= input.thresholdTokens),
        ...(input.controlMessageId ? { controlMessageId: input.controlMessageId } : {}),
        ...(plan.outcome === "no_compaction"
          ? { refusal: "nothing_to_compact" as const }
          : !plan.minimalTailFits
            ? { refusal: "context_too_large" as const }
            : {}),
      }
    : { kind: "too_large", plan };
}
