import type { ArtifactRef, MeridianError } from "../interrupt/index.js";
import type { JsonValue } from "../threads/index.js";

export type ReturnResultCapture = {
  summary: string;
  payload?: JsonValue;
  artifacts?: AgentReport["artifacts"];
};

export type AgentReport = {
  threadId: string;
  summary: string;
  payload?: JsonValue;
  artifacts?: ArtifactRef[];
  costMillicredits: number;
  incomplete?: boolean;
};

export type SpawnResult =
  | { status: "completed"; report: AgentReport }
  | { status: "error"; error: MeridianError };

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
