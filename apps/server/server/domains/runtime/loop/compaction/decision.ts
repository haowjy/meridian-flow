/** A request boundary's compaction choice; committed with its selected leaf and inbox batch. */

import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { SummaryRejectionReason } from "@meridian/contracts/runtime";
import type { Block, Turn } from "@meridian/contracts/threads";
import {
  type CompactionFailureOutcome,
  type CompactionFailurePhase,
  type CompactionFailureReason,
  compactionFailedCopy,
} from "../../../threads/index.js";
import type { GenerateRequest, TokenizerFamily } from "../../gateway/index.js";
import { estimateRequestTokens } from "./estimate.js";
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
      instructions?: string;
      refusal?: "context_too_large" | "compaction_failed";
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
    super(compactionFailureDiagnosticMessage(reason));
  }
}

export class CompactionFailureError extends CompactionPreparationError {
  constructor(readonly outcome: CompactionFailureOutcome) {
    super(outcome.reason);
  }
}

export function compactionFailureDiagnosticMessage(reason: CompactionFailureReason): string {
  switch (reason) {
    case "context_too_large":
      return "This message is too long for this chat's model.";
    case "context_window_exceeded":
      return "This conversation still exceeds the model's context window after compaction. Try a smaller request.";
    default:
      return compactionFailedCopy;
  }
}

/** Keep rejection reasons in details instead of expanding the system error-code family. */
export function compactionFailureMeridianError(failure: CompactionFailureOutcome, message: string) {
  const code =
    failure.reason === "context_too_large" || failure.reason === "context_window_exceeded"
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
  instructions?: string;
  baseline: { inputTokens: number; messageCount: number } | null;
  tokenizer: TokenizerFamily;
}): CompactionDecision {
  const fitLimitTokens = input.forcedDecision?.fitLimitTokens ?? input.thresholdTokens;
  if (fitLimitTokens === null) return { kind: "generate" };
  const tokensBefore = estimateRequestTokens(input);
  if (!input.forcedDecision && tokensBefore < fitLimitTokens) return { kind: "generate" };
  const planInput = {
    turns: input.turns,
    blocks: input.blocks,
    fitLimitTokens,
    tailBudgetBaseTokens:
      input.forcedDecision?.trigger === "manual"
        ? Math.min(input.thresholdTokens ?? fitLimitTokens, tokensBefore)
        : fitLimitTokens,
    pinnedRequestTurnIds: input.pinnedRequestTurnIds,
    fixedOverheadTokens: estimateRequestTokens({
      tokenizer: input.tokenizer,
      request: {
        ...input.request,
        messages: input.request.messages.filter((message) => message.role === "system"),
      },
      baseline: null,
    }),
    tokenizer: input.tokenizer,
  } satisfies Parameters<typeof planCompaction>[0];
  let plan = planCompaction(planInput);
  if (
    input.forcedDecision?.trigger === "manual" &&
    (plan.outcome === "no_compaction" ||
      projectCompactedHistory(input.activeHistory, plan).blocks.length === 0)
  ) {
    plan = planCompaction({ ...planInput, minimalTail: true });
  }
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
        ...(input.controlMessageId ? { controlMessageId: input.controlMessageId } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(plan.outcome === "no_compaction"
          ? { refusal: "compaction_failed" as const }
          : !plan.minimalTailFits
            ? { refusal: "context_too_large" as const }
            : {}),
      }
    : { kind: "too_large", plan };
}
