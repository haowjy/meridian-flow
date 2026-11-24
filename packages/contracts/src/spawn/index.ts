import { z } from "zod";
import { type ArtifactRef, artifactRefSchema } from "../artifacts/index.js";
import { parseContextUri } from "../context-uri.js";
import { type MeridianError, meridianErrorSchema } from "../errors/index.js";
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

const artifactUriSchema = z.string().transform((uri, context): ArtifactRef => {
  const parsed = parseContextUri(uri);
  if (parsed.ok && parsed.value.path) return { type: "object", uri: parsed.value.normalized };
  context.addIssue({
    code: "custom",
    message: `Expected a Meridian document URI, received ${JSON.stringify(uri)}.`,
  });
  return z.NEVER;
});

export type ReturnResultCapture = {
  summary: string;
  payload?: JsonValue;
  artifacts?: AgentReport["artifacts"];
};

export const returnResultCaptureSchema = z.strictObject({
  summary: z.string(),
  payload: jsonValueSchema.optional(),
  artifacts: z.array(artifactUriSchema).optional(),
});

export type ReturnResultOutcome = { ok: true } | { ok: false; message: string };

export type SavedOutcome = "succeeded" | "failed" | "cancelled";
export type ExecutionReportSource = "return_result" | "final_assistant" | "empty";
type ExecutionReportOrigin = "spawn" | "message" | "thread_run";
export type ExecutionReportDelivery = "background_notification" | "direct" | "none";

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
  admittedAt: string;
  handle: string;
  origin: ExecutionReportOrigin;
  deliveryMode: ExecutionReportDelivery;
  callerThreadId: ThreadId | null;
  callerTurnId: TurnId | null;
  toolCallId: string | null;
  cardBlockId: TurnBlockId | null;
  agentSlug: string | null;
  name: string | null;
  capture: ReturnResultCapture | null;
  captureToolCallId: string | null;
  reason: string | null;
  payload?: JsonValue;
  artifacts: ArtifactRef[] | null;
  costMillicredits: number | null;
  publication: "none" | "pending" | "published";
  publishedAt: string | null;
  noticeWithdrawn: boolean;
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

export type AgentReport = {
  handle: string;
  threadId: string;
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
      execution?: TurnId;
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

type AssertJsonValue<T extends JsonValue> = T;
type _SpawnResultIsJsonValue = AssertJsonValue<SpawnResult>;

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
