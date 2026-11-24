import type { MeridianError } from "@meridian/contracts/errors";
import { meridianErrorFromSystem } from "@meridian/contracts/errors";
import { DEFAULT_MAX_SPAWN_DEPTH, type TreeBudget } from "@meridian/contracts/spawn";

export function resolveMaxSpawnDepth(env: {
  MERIDIAN_MAX_SPAWN_DEPTH?: string | undefined;
}): number {
  const parsed = Number(env.MERIDIAN_MAX_SPAWN_DEPTH);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SPAWN_DEPTH;
}

export function assertSpawnDepthAllowed(
  budget: TreeBudget,
  parentSpawnDepth: number,
): MeridianError | null {
  const childDepth = parentSpawnDepth + 1;
  if (childDepth > budget.maxDepth) {
    return meridianErrorFromSystem(
      "spawn_depth_exceeded",
      `Spawn depth ${childDepth} exceeds maxDepth ${budget.maxDepth}.`,
    );
  }
  return null;
}

export function assertTurnBudget(budget: TreeBudget): MeridianError | null {
  if (budget.spent.totalTurns >= budget.maxTotalTurns) {
    return meridianErrorFromSystem(
      "turn_budget_exceeded",
      `Turn budget exhausted (${budget.maxTotalTurns})`,
    );
  }
  return null;
}

export function assertCostBudget(
  budget: TreeBudget,
  additionalMillicredits: number,
): MeridianError | null {
  if (
    (additionalMillicredits === 0 && budget.spent.costMillicredits >= budget.maxCostMillicredits) ||
    budget.spent.costMillicredits + additionalMillicredits > budget.maxCostMillicredits
  ) {
    return meridianErrorFromSystem(
      "cost_budget_exceeded",
      `Cost budget exhausted (${budget.maxCostMillicredits} millicredits)`,
    );
  }
  return null;
}

export function recordTurnSpend(budget: TreeBudget): void {
  budget.spent.totalTurns += 1;
}

export function recordCostSpend(budget: TreeBudget, millicredits: number): void {
  budget.spent.costMillicredits += millicredits;
}
