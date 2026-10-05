/**
 * Purpose: JSON-natural spawn primitive contracts — child terminal reports,
 * spawn tool results, and the per-run tree budget object threaded by reference.
 * Key decisions: SpawnResult union reserves a future interrupt arm; TreeBudget
 * spent counters are updated in-process until P4 wires the ledger.
 */

import { z } from "zod";
import { parseContextUri } from "../context-uri.js";
import {
  type ArtifactRef,
  artifactRefSchema,
  type MeridianError,
  meridianErrorSchema,
} from "../interrupt/index.js";
import type { ThreadId, TurnBlockId, TurnId } from "../runtime/index.js";
import type { JsonValue } from "../threads/index.js";

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const artifactUriSchema = z
  .string()
  .superRefine((uri, context) => {
    const parsed = parseContextUri(uri);
    if (!uri.includes("://") || !parsed.ok || !parsed.value.path) {
      context.addIssue({
        code: "custom",
        message: `Expected a Meridian document URI, received ${JSON.stringify(uri)}.`,
      });
    }
  })
  .transform((uri): ArtifactRef => ({ type: "object", uri }));

/** Candidate content supplied by return_result, before terminal cause is known. */
export type ReturnResultCapture = {
  summary: string;
  payload?: JsonValue;
  artifacts?: AgentReport["artifacts"];
};

/** Canonical return_result input; artifact URI strings resolve to object refs. */
export const returnResultCaptureSchema = z.strictObject({
  summary: z.string(),
  payload: jsonValueSchema.optional(),
  artifacts: z.array(artifactUriSchema).optional(),
});

/** A run accepts one report; a second return_result is refused, not thrown. */
export type ReturnResultOutcome = { ok: true } | { ok: false; message: string };

export type SavedOutcome = "succeeded" | "failed" | "cancelled";
export type ExecutionReportSource = "return_result" | "final_assistant" | "empty";
type ExecutionReportOrigin = "spawn" | "message" | "thread_run";
export type ExecutionReportDelivery = "background_notification" | "direct" | "none";

/** Durable user-facing identity carried by a child-completion turn. */
export type SubagentUpdateMetadata = {
  kind: "subagent_update";
  handle: string;
  execution: string | null;
  outcome: SavedOutcome;
  childThreadId: ThreadId;
  agentName: string;
};

const subagentUpdateMetadataSchema = z.object({
  kind: z.literal("subagent_update"),
  handle: z.string(),
  execution: z.string().nullable(),
  outcome: z.enum(["succeeded", "failed", "cancelled"]),
  childThreadId: z.string(),
  agentName: z.string(),
});

export function parseSubagentUpdateMetadata(value: unknown): SubagentUpdateMetadata | null {
  const parsed = subagentUpdateMetadataSchema.safeParse(value);
  return parsed.success ? (parsed.data as SubagentUpdateMetadata) : null;
}

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
  terminalTurnId: TurnId | null;
  childThreadId: ThreadId;
  executionTurnId: TurnId;
  /** Durable report-row creation time, which commits with run admission. */
  admittedAt: string;
  handle: string;
  origin: ExecutionReportOrigin;
  deliveryMode: ExecutionReportDelivery;
  callerThreadId: ThreadId | null;
  callerTurnId: TurnId | null;
  toolCallId: string | null;
  cardBlockId: TurnBlockId | null;
  agentSlug: string | null;
  /** The spawn's task label (`spawn.name`). */
  name: string | null;
  capture: ReturnResultCapture | null;
  captureToolCallId: string | null;
  reason: string | null;
  payload?: JsonValue;
  artifacts: ArtifactRef[] | null;
  costMillicredits: number | null;
  publication: "none" | "pending" | "published";
  publishedAt: string | null;
} & (
  | { outcome: null; source: null; summary: null; terminalAt: null }
  | { outcome: SavedOutcome; source: ExecutionReportSource; summary: string; terminalAt: string }
);

export type ThreadReportResult =
  | { ok: false; error: MeridianError }
  | {
      childThreadId: ThreadId;
      ref: string;
      run: number;
      outcome: SavedOutcome;
      deliveryMode: ExecutionReportDelivery;
      source: ExecutionReportSource;
      summary: string;
      payload?: JsonValue;
      artifacts?: ArtifactRef[];
      partial: boolean;
      reason: string | null;
    }
  | { childThreadId: ThreadId; ref: string; status: "not_ready" | "unavailable" };

/**
 * The model's `thread_report` result: the child's latest finished report. It
 * has no run number (D6, D17); `running` marks a newer run still in progress,
 * and `message` carries the line the model reads about it.
 */
export type ModelThreadReportResult =
  | Extract<ThreadReportResult, { ok: false }>
  | {
      ref: string;
      outcome: SavedOutcome;
      summary: string;
      payload?: JsonValue;
      artifacts?: ArtifactRef[];
      reason?: string;
      partial?: true;
      source?: ExecutionReportSource;
      running?: true;
      message?: string;
    }
  | { ref: string; status: "not_ready" | "unavailable"; message?: string };

const threadReportResultSchema = z.union([
  z.object({ ok: z.literal(false), error: meridianErrorSchema }),
  z.object({
    childThreadId: z.string(),
    ref: z.string(),
    run: z.number().int().positive(),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    deliveryMode: z.enum(["background_notification", "direct", "none"]),
    source: z.enum(["return_result", "final_assistant", "empty"]),
    summary: z.string(),
    payload: jsonValueSchema.optional(),
    artifacts: z.array(artifactRefSchema).optional(),
    partial: z.boolean(),
    reason: z.string().nullable(),
  }),
  z.object({
    childThreadId: z.string(),
    ref: z.string(),
    status: z.enum(["not_ready", "unavailable"]),
  }),
  z.object({
    ref: z.string(),
    outcome: z.enum(["succeeded", "failed", "cancelled"]),
    summary: z.string(),
    payload: jsonValueSchema.optional(),
    artifacts: z.array(artifactRefSchema).optional(),
    reason: z.string().optional(),
    partial: z.literal(true).optional(),
    source: z.enum(["return_result", "final_assistant", "empty"]).optional(),
    running: z.literal(true).optional(),
    message: z.string().optional(),
  }),
  z.object({
    ref: z.string(),
    status: z.enum(["not_ready", "unavailable"]),
    message: z.string().optional(),
  }),
]);

/** Client-facing saved report details shared by the tool output and API reader. */
export type SavedReportContentValue = {
  summary: string;
  payload?: JsonValue;
  artifacts: ArtifactRef[];
  partial?: boolean;
  outcome?: SavedOutcome | null;
  reason?: string | null;
};

export function parseThreadReportResult(
  value: unknown,
): ThreadReportResult | ModelThreadReportResult | null {
  const parsed = threadReportResultSchema.safeParse(value);
  return parsed.success ? (parsed.data as ThreadReportResult | ModelThreadReportResult) : null;
}

/** Project a ready saved report into the common report-content presentation shape. */
export function toReportContentValue(
  report: ThreadReportResult | ModelThreadReportResult | null,
): SavedReportContentValue | null {
  if (!report || "status" in report || "error" in report) return null;
  return {
    summary: report.summary,
    ...(report.payload === undefined ? {} : { payload: report.payload }),
    artifacts: report.artifacts ?? [],
    partial: report.partial ?? report.outcome !== "succeeded",
    outcome: report.outcome,
    reason: "reason" in report ? (report.reason ?? null) : null,
  };
}

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
  /** Where the report came from: `return_result`, the final reply, or nothing. */
  source: ExecutionReportSource;
  summary: string;
  payload?: JsonValue;
  artifacts?: ArtifactRef[];
};

export type SpawnResult =
  | { status: "completed"; execution: TurnId; outcome: "succeeded"; report: AgentReport }
  | {
      status: "background";
      handle: string;
      threadId: string;
      agentSlug: string;
      name?: string;
      /** Present for a spawned execution; absent for queue-only thread_message. */
      execution?: TurnId;
      /**
       * Queue-only thread_message: true when the caller re-tasked its own child,
       * so the caller gets the completion notice when that run finishes. A
       * queued message gets no helper card either way.
       */
      notifiesCaller?: boolean;
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
