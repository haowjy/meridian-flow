import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/errors";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { TreeBudget } from "@meridian/contracts/spawn";
import type { Thread } from "@meridian/contracts/threads";
import type { GenerateResult } from "@meridian-flow/runtime/gateway";
import type { BillingUsagePolicy } from "../../billing/index.js";
import {
  type ComputedModelCost,
  computeModelCost,
  type ModelTokenRateSource,
} from "../costing/pricing.js";
import {
  assertCostBudget,
  assertTurnBudget,
  recordCostSpend,
  recordTurnSpend,
} from "../spawn/tree-budget.js";

export interface TurnAccountingDeps {
  billingUsage: BillingUsagePolicy;
  rateSource: ModelTokenRateSource;
}

export interface TurnAccounting {
  assertPreIterationBudget(treeBudget: TreeBudget, thread: Thread): Promise<MeridianError | null>;
  assertContinuationEligibility(
    remainingIterations: number,
    treeBudget: TreeBudget,
    thread: Thread,
  ): Promise<MeridianError | string | null>;
  recordIterationSpend(treeBudget: TreeBudget): void;
  computeAndDebit(
    response: Pick<GenerateResult, "provider" | "model" | "usage" | "meteringStatus">,
    thread: Thread,
    threadId: ThreadId,
    turnId: TurnId,
    treeBudget: TreeBudget,
    usageEventId: string,
  ): Promise<ComputedModelCost>;
}

export function createTurnAccounting(deps: TurnAccountingDeps): TurnAccounting {
  const recordedSpend = new Set<string>();
  return {
    async assertPreIterationBudget(
      treeBudget: TreeBudget,
      thread: Thread,
    ): Promise<MeridianError | null> {
      const turnBudgetError = assertTurnBudget(treeBudget);
      if (turnBudgetError) return turnBudgetError;

      const costBudgetError = assertCostBudget(treeBudget, 0);
      if (costBudgetError) return costBudgetError;

      if (!(await deps.billingUsage.canContinueModelCall(thread.userId))) {
        return meridianErrorFromSystem(
          "credits_exhausted",
          "Your usage balance is exhausted; add balance before starting another model call",
        );
      }

      return null;
    },

    async assertContinuationEligibility(remainingIterations, treeBudget, thread) {
      if (remainingIterations <= 0) return "exceeded max tool iterations";
      return this.assertPreIterationBudget(treeBudget, thread);
    },

    recordIterationSpend(treeBudget: TreeBudget): void {
      recordTurnSpend(treeBudget);
    },

    async computeAndDebit(
      response: Pick<GenerateResult, "provider" | "model" | "usage" | "meteringStatus">,
      thread: Thread,
      threadId: ThreadId,
      turnId: TurnId,
      treeBudget: TreeBudget,
      usageEventId: string,
    ): Promise<ComputedModelCost> {
      const computedCost = computeModelCost({
        provider: response.provider,
        model: response.model,
        usage: response.usage,
        meteringStatus: response.meteringStatus,
        rateSource: deps.rateSource,
      });

      if (BigInt(computedCost.millicredits) > 0n) {
        await deps.billingUsage.debit({
          userId: thread.userId,
          rootThreadId: thread.rootThreadId,
          threadId: threadId as string,
          turnId: turnId as string,
          millicredits: computedCost.millicredits,
          usageEventId,
        });
      }

      if (!recordedSpend.has(usageEventId)) {
        recordCostSpend(treeBudget, Number(computedCost.millicredits));
        recordedSpend.add(usageEventId);
      }
      return computedCost;
    },
  };
}
