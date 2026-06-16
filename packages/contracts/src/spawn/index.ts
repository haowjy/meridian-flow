/**
 * Purpose: JSON-natural spawn primitive contracts — child terminal reports,
 * spawn tool results, and the per-run tree budget object threaded by reference.
 * Key decisions: SpawnResult union reserves a future checkpoint arm; TreeBudget
 * spent counters are updated in-process until P4 wires the ledger.
 */
import type { ArtifactRef, MeridianError } from "../interrupt/index.js";
import type { JsonValue } from "../threads/index.js";

/**
 * What a child returns through return_result before final child cost is known.
 * ChildRunCoordinator folds in costMillicredits after the child turn stops.
 */
export type ReturnResultCapture = {
  summary: string;
  payload?: JsonValue;
  artifacts?: AgentReport["artifacts"];
};

/** Child agent terminal hand-back (execution-model §4.1). */
export type AgentReport = {
  threadId: string;
  summary: string;
  payload?: JsonValue;
  artifacts?: ArtifactRef[];
  costMillicredits: number;
  /** Set when the child ended without calling return_result. */
  incomplete?: boolean;
};

export type SpawnResult =
  | { status: "completed"; report: AgentReport }
  | { status: "background"; threadId: string; agentSlug: string; description?: string }
  | { status: "error"; error: MeridianError };
// DEFERRED(checkpoint-bubbling): add { status: "checkpoint" } arm when a deep worker must reach the human without parent mediation — no pilot case

type AssertJsonValue<T extends JsonValue> = T;
// Guards SpawnResult against future non-JSON fields before it reaches thread persistence.
type _SpawnResultIsJsonValue = AssertJsonValue<SpawnResult>;

/** Per-run budget threaded by reference across the agent tree (§7.2). */
export interface TreeBudget {
  maxDepth: number;
  maxTotalTurns: number;
  maxCostMillicredits: number;
  spent: {
    totalTurns: number;
    costMillicredits: number;
  };
}

export const DEFAULT_MAX_SPAWN_DEPTH = 2;

export function createDefaultTreeBudget(
  overrides: Partial<Pick<TreeBudget, "maxDepth" | "maxTotalTurns" | "maxCostMillicredits">> = {},
): TreeBudget {
  return {
    maxDepth: overrides.maxDepth ?? DEFAULT_MAX_SPAWN_DEPTH,
    maxTotalTurns: overrides.maxTotalTurns ?? 64,
    maxCostMillicredits: overrides.maxCostMillicredits ?? 1_000_000_000,
    spent: { totalTurns: 0, costMillicredits: 0 },
  };
}
