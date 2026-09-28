/** A request boundary's compaction choice; committed with its selected leaf and inbox batch. */

import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { SummaryRejectionReason } from "@meridian/contracts/runtime";
import type { Block, Turn } from "@meridian/contracts/threads";
import type {
  CompactionFailureOutcome,
  CompactionFailurePhase,
  CompactionFailureReason,
} from "../../../threads/index.js";
import { orderTurnsByPosition } from "../../../threads/order-turns.js";
import type { GenerateRequest, TokenizerFamily } from "../../gateway/index.js";
import { estimateRequestTokens, estimateTurnTokens } from "./estimate.js";
import { type CompactionPlan, planCompaction } from "./plan.js";
import { type ProjectedActiveHistory, projectCompactedHistory } from "./project.js";

/** A boundary-owned forced preparation, never a replacement for its prepare callback. */
export interface ForcedCompactionDecision {
  kind: "compact";
  trigger: "auto" | "manual";
  fitLimitTokens: number;
  knownTooLarge?: boolean;
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
      knownTooLarge?: boolean;
    }
  | { kind: "too_large"; plan: CompactionPlan };

export type { CompactionFailureOutcome, CompactionFailurePhase, CompactionFailureReason };

export class CompactionPreparationError extends Error {
  constructor(readonly reason: CompactionFailureReason) {
    super(compactionFailureMessage(reason));
  }
}

export class CompactionFailureError extends CompactionPreparationError {
  constructor(readonly outcome: CompactionFailureOutcome) {
    super(outcome.reason);
  }
}

export function compactionFailureMessage(reason: CompactionFailureReason): string {
  switch (reason) {
    case "nothing_to_compact":
      return "There is nothing to compact yet.";
    case "context_too_large":
      return "This message is too long for this chat's model.";
    case "context_window_exceeded":
      return "This conversation still exceeds the model's context window after compaction. Try a smaller request.";
    default:
      return "This conversation couldn't be compacted. Try again.";
  }
}

/** Keep rejection reasons in details instead of expanding the system error-code family. */
export function compactionFailureMeridianError(failure: CompactionFailureOutcome, message: string) {
  const code =
    failure.reason === "context_too_large" ||
    failure.reason === "nothing_to_compact" ||
    failure.reason === "context_window_exceeded"
      ? failure.reason
      : "compaction_failed";
  return {
    ...meridianErrorFromSystem(code, message),
    details: {
      reason: failure.reason,
      phase: failure.phase,
      ...(failure.estimatedTokens === undefined
        ? {}
        : { estimatedTokens: failure.estimatedTokens }),
      ...(failure.fitLimitTokens === undefined ? {} : { fitLimitTokens: failure.fitLimitTokens }),
    },
  };
}

/** Preserve known outcomes across async preparation and the delivery transaction. */
export function compactionFailureFrom(
  error: unknown,
  phase: CompactionFailurePhase,
): CompactionFailureOutcome {
  if (error instanceof CompactionFailureError) return error.outcome;
  if (error instanceof CompactionPreparationError) return { reason: error.reason, phase };
  return { reason: "compaction_failed", phase };
}

export function summaryCompactionFailure(
  reason: SummaryRejectionReason | undefined,
): CompactionFailureOutcome {
  return { reason: reason ?? "compaction_failed", phase: "summary" };
}

export function decideCompaction(input: {
  request: GenerateRequest;
  turns: Turn[];
  activeHistory: ProjectedActiveHistory;
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
  const compactable =
    plan.outcome === "planned" && input.forcedDecision?.trigger === "manual"
      ? projectCompactedHistory(input.activeHistory, plan)
      : null;
  const belowSummaryFloor =
    compactable !== null &&
    compactable.turns.reduce(
      (tokens, turn) =>
        tokens +
        estimateTurnTokens(
          turn,
          compactable.blocks.filter((block) => block.turnId === turn.id),
          input.tokenizer,
        ),
      0,
    ) < input.summaryReserveTokens;
  // A retained tail is not new history: consecutive manual controls cannot
  // repeatedly summarize it without an intervening completed turn.
  const immediatelyAfterCompaction =
    input.forcedDecision?.trigger === "manual" &&
    orderTurnsByPosition(input.turns)
      .reverse()
      .find((turn) => turn.status === "complete")?.role === "compaction";
  return input.forcedDecision?.trigger === "manual" ||
    (plan.outcome === "planned" && plan.minimalTailFits)
    ? {
        kind: "compact",
        plan,
        requestInHand: input.request,
        trigger: input.forcedDecision?.trigger ?? "auto",
        fitLimitTokens,
        ...(input.forcedDecision?.knownTooLarge
          ? { knownTooLarge: input.forcedDecision.knownTooLarge }
          : {}),
        tokensBefore,
        required:
          input.forcedDecision?.trigger !== "manual" ||
          (input.thresholdTokens !== null && tokensBefore >= input.thresholdTokens),
        ...(input.controlMessageId ? { controlMessageId: input.controlMessageId } : {}),
        ...(immediatelyAfterCompaction || plan.outcome === "no_compaction" || belowSummaryFloor
          ? { refusal: "nothing_to_compact" as const }
          : !plan.minimalTailFits
            ? { refusal: "context_too_large" as const }
            : {}),
      }
    : { kind: "too_large", plan };
}
