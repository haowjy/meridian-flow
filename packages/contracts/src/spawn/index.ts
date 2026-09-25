/**
 * Purpose: JSON-natural spawn primitive contracts — child terminal reports,
 * spawn tool results, and the per-run tree budget object threaded by reference.
 * Key decisions: SpawnResult union reserves a future interrupt arm; TreeBudget
 * spent counters are updated in-process until P4 wires the ledger.
 */
import type { ArtifactRef, MeridianError } from "../interrupt/index.js";
import type { ThreadId, TurnBlockId, TurnId } from "../runtime/index.js";
import type { JsonValue } from "../threads/index.js";

/** Candidate content supplied by return_result, before terminal cause is known. */
export type ReturnResultCapture = {
  summary: string;
  payload?: JsonValue;
  artifacts?: AgentReport["artifacts"];
};

/** A run accepts one report; a second return_result is refused, not thrown. */
export type ReturnResultOutcome = { ok: true } | { ok: false; message: string };

export type SavedOutcome = "succeeded" | "failed" | "cancelled";
export type ExecutionReportSource = "return_result" | "final_assistant" | "empty";
export type ExecutionReportOrigin = "spawn" | "foreground_message" | "thread_run";
export type ExecutionReportDelivery = "background_notification" | "direct" | "none";

/** Parent-side identity passed at child admission; the child turn ID is added only after admission commits. */
export type ExecutionReportCorrelation = {
  callerThreadId: ThreadId | null;
  callerTurnId: TurnId | null;
  toolCallId: string | null;
  cardBlockId: TurnBlockId | null;
  origin: ExecutionReportOrigin;
  deliveryMode: ExecutionReportDelivery;
};

export type SavedExecutionReport = {
  childThreadId: ThreadId;
  assistantTurnId: TurnId;
  handle: string;
  origin: ExecutionReportOrigin;
  deliveryMode: ExecutionReportDelivery;
  callerThreadId: ThreadId | null;
  callerTurnId: TurnId | null;
  toolCallId: string | null;
  cardBlockId: TurnBlockId | null;
  agentSlug: string | null;
  description: string | null;
  capture: ReturnResultCapture | null;
  captureToolCallId: string | null;
  reason: string | null;
  payload?: JsonValue;
  artifacts: ArtifactRef[] | null;
  costMillicredits: number | null;
  publication: "none" | "pending" | "published" | "skipped";
  publishedAt: string | null;
} & (
  | { outcome: null; source: null; summary: null; terminalAt: null }
  | { outcome: SavedOutcome; source: ExecutionReportSource; summary: string; terminalAt: string }
);

export type ThreadReportResult =
  | {
      ref: string;
      execution: TurnId;
      outcome: SavedOutcome;
      source: ExecutionReportSource;
      summary: string;
      payload?: JsonValue;
      artifacts?: ArtifactRef[];
      partial: boolean;
      reason: string | null;
    }
  | { ref: string; execution: TurnId; status: "not_ready" | "unavailable" };

export function isReturnResultOutcome(value: unknown): value is ReturnResultOutcome {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!("ok" in value)) return false;
  if (value.ok === true) return true;
  return value.ok === false && "message" in value && typeof value.message === "string";
}

/** Child agent terminal hand-back (execution-model §4.1). */
export type AgentReport = {
  /** Short model-facing handle (`pN`); the model's currency for thread_message. */
  handle: string;
  /** Internal UUID for UI navigation; never sent to the model. */
  threadId: string;
  summary: string;
  payload?: JsonValue;
  artifacts?: ArtifactRef[];
  costMillicredits: number;
};

export type SpawnResult =
  | { status: "completed"; execution: TurnId; outcome: "succeeded"; report: AgentReport }
  | {
      status: "background";
      handle: string;
      threadId: string;
      agentSlug: string;
      description?: string;
      /** Present for a spawned execution; absent for queue-only thread_message. */
      execution?: TurnId;
    }
  | {
      status: "error";
      error: MeridianError;
      execution?: TurnId;
      outcome?: "failed" | "cancelled";
      report?: AgentReport;
      partial?: boolean;
      reason?: string | null;
    };
// DEFERRED(interrupt-bubbling): add { status: "interrupt" } arm when a deep worker must reach the human without parent mediation — no pilot case

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

export const DEFAULT_MAX_SPAWN_DEPTH = 3;

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
