/**
 * Turn accounting for the runtime loop.
 *
 * This collaborator owns pre-call budget checks, per-iteration spend, model
 * price computation, credit debits, and tree-budget cost recording. Keeping
 * these side effects behind one interface leaves the orchestrator responsible
 * for control flow while billing remains centralized and testable.
 */

import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { TreeBudget } from "@meridian/contracts/spawn";
import type { Thread } from "@meridian/contracts/threads";
import type { BillingUsagePolicy } from "../../billing/index.js";
import { type ComputedModelCost, computeModelCost } from "../costing/pricing.js";
import type { GenerateResult } from "../gateway/index.js";
import {
  assertCostBudget,
  assertTurnBudget,
  recordCostSpend,
  recordTurnSpend,
} from "../spawn/tree-budget.js";

export interface TurnAccountingDeps {
  billingUsage: BillingUsagePolicy;
}

export interface TurnAccounting {
  /** Pre-iteration budget and credit checks. Returns MeridianError if exhausted. */
  assertPreIterationBudget(treeBudget: TreeBudget, thread: Thread): Promise<MeridianError | null>;
  /** Record one iteration spent against the tree budget. */
  recordIterationSpend(treeBudget: TreeBudget): void;
  /** Compute cost for a model response and debit credits. */
  computeAndDebit(
    response: GenerateResult,
    thread: Thread,
    threadId: ThreadId,
    turnId: TurnId,
    treeBudget: TreeBudget,
    usageEventId: string,
  ): Promise<ComputedModelCost>;
}

export function createTurnAccounting(deps: TurnAccountingDeps): TurnAccounting {
  return {
    async assertPreIterationBudget(
      treeBudget: TreeBudget,
      thread: Thread,
    ): Promise<MeridianError | null> {
      const turnBudgetError = assertTurnBudget(treeBudget);
      if (turnBudgetError) return turnBudgetError;

      const costBudgetError = assertCostBudget(treeBudget, 0);
      if (costBudgetError) return costBudgetError;

      // Mid-stream calls keep go-negative grace: a turn that spent its last
      // positive balance may finish, but further model calls stop once debt exists.
      // DEFERRED(atomic-reserve): pre-call check suffices under serial spawns (design §7.2); reservation/hold semantics land with parallel spawns.
      if (!(await deps.billingUsage.canContinueModelCall(thread.userId))) {
        return meridianErrorFromSystem(
          "credits_exhausted",
          "Your usage balance is exhausted; add balance before starting another model call",
        );
      }

      return null;
    },

    recordIterationSpend(treeBudget: TreeBudget): void {
      recordTurnSpend(treeBudget);
    },

    async computeAndDebit(
      response: GenerateResult,
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
        providerData: response.providerData,
      });

      if (BigInt(computedCost.millicredits) > 0n) {
        // Meter-pause while parked holds by construction: only model responses
        // debit credits, and no model calls run while a turn is waiting_checkpoint.
        await deps.billingUsage.debit({
          userId: thread.userId,
          rootThreadId: thread.rootThreadId,
          threadId: threadId as string,
          turnId: turnId as string,
          agentSlug: thread.currentAgent ?? "unknown",
          millicredits: computedCost.millicredits,
          usageEventId,
        });
      }

      // DEFERRED(bigint-millicredits): pilot scale is orders of magnitude below 2^53; move to bigint/string end-to-end when balances can exceed it.
      recordCostSpend(treeBudget, Number(computedCost.millicredits));
      return computedCost;
    },
  };
}
