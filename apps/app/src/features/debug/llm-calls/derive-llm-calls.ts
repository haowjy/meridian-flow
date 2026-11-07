/** Defensive projection from untrusted gateway records into the LLM Calls dashboard model. */
import type {
  EventCorrelation,
  EventLevel,
  EventRecord,
  TraceStreamRef,
} from "@meridian/contracts/observability";
import type { ModelResponse, TurnStatus } from "@meridian/contracts/threads";
import { cacheHitPercent } from "@meridian/thread-client";

export type LlmCallOutcome = "in-flight" | "ok" | "cancelled" | "error";

export type LlmCallChunkSummary = {
  messageClass: string;
  count: number;
};

export type LlmCallSummary = {
  gatewayCallId: string;
  startedAt: string;
  lastEventAt: string;
  provider?: string;
  model?: string;
  outcome: LlmCallOutcome;
  /** Gateway error code from the close record, kept when a stop is shown as cancelled. */
  errorCode?: string;
  firstOutputMs?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  threadId?: string;
  turnId?: string;
  iteration?: number;
  agentSlug?: string;
  lifecycleEvents: EventRecord[];
  chunks: LlmCallChunkSummary[];
  chunkCount: number;
};

export type LlmCallCacheComparison = {
  response: ModelResponse;
  predictedState: ModelResponse["predictedCacheState"];
  predictedReason: ModelResponse["predictedCacheReason"];
  cacheHitPercent: number | null;
  mismatch: boolean;
};

export type LlmCallTurn = { status: TurnStatus; responses: readonly ModelResponse[] };

/**
 * A stop before any output reaches the gateway as an `invalid_request` error, the same
 * code a real bad request gets, and the gateway records carry nothing else to tell them
 * apart. The turn does: a rejected request ends its turn as `error`, so an
 * `invalid_request` on the last call of a `cancelled` turn is the writer's stop.
 */
export function settleStoppedCalls(
  calls: readonly LlmCallSummary[],
  turns: Readonly<Record<string, LlmCallTurn>>,
): LlmCallSummary[] {
  const lastStartByTurn = new Map<string, string>();
  for (const call of calls) {
    if (!call.turnId) continue;
    const last = lastStartByTurn.get(call.turnId);
    if (last === undefined || call.startedAt > last)
      lastStartByTurn.set(call.turnId, call.startedAt);
  }
  return calls.map((call) =>
    call.outcome === "error" &&
    call.errorCode === "invalid_request" &&
    call.turnId &&
    turns[call.turnId]?.status === "cancelled" &&
    lastStartByTurn.get(call.turnId) === call.startedAt
      ? { ...call, outcome: "cancelled" }
      : call,
  );
}

/** Pair finished gateway calls with persisted responses and compare prediction to observation. */
export function pairLlmCallResponses(
  calls: readonly LlmCallSummary[],
  turns: Readonly<Record<string, LlmCallTurn>>,
): Map<string, LlmCallCacheComparison> {
  const result = new Map<string, LlmCallCacheComparison>();
  const byTurn = new Map<string, LlmCallSummary[]>();
  for (const call of calls) {
    if (!call.turnId || !call.threadId) continue;
    const group = byTurn.get(call.turnId) ?? [];
    group.push(call);
    byTurn.set(call.turnId, group);
  }

  for (const [turnId, turnCalls] of byTurn) {
    const orderedCalls = turnCalls
      .filter((call) => call.outcome === "ok" || call.outcome === "cancelled")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const available = [...(turns[turnId]?.responses ?? [])].sort((a, b) => a.sequence - b.sequence);
    for (const call of orderedCalls) {
      const responseIndex = available.findIndex((response) => response.model === call.model);
      if (responseIndex < 0) continue;
      const [response] = available.splice(responseIndex, 1);
      if (!response) continue;
      const hitPercent =
        response.cacheReadTokens == null
          ? null
          : cacheHitPercent(response.cacheReadTokens, response.inputTokens);
      const mismatch =
        (response.predictedCacheState === "warm" && response.cacheReset) ||
        (response.predictedCacheState === "cold" &&
          response.predictedCacheReason !== "ttl_unknown" &&
          hitPercent !== null &&
          hitPercent >= 50);
      result.set(call.gatewayCallId, {
        response,
        predictedState: response.predictedCacheState,
        predictedReason: response.predictedCacheReason,
        cacheHitPercent: hitPercent,
        mismatch,
      });
    }
  }
  return result;
}

const OUTCOME_PRECEDENCE: Record<Exclude<LlmCallOutcome, "in-flight">, number> = {
  ok: 0,
  cancelled: 1,
  error: 2,
};

const CORRELATION_STRING_KEYS = [
  "traceId",
  "runId",
  "parentRunId",
  "requestId",
  "threadId",
  "turnId",
  "childRunId",
  "agentSlug",
  "attemptId",
  "gatewayCallId",
  "provider",
  "model",
  "route",
  "method",
  "projectId",
  "workId",
  "toolName",
  "toolCallId",
  "errorCode",
  "documentId",
  "draftId",
  "yjsSpans",
] as const;

const CORRELATION_NUMBER_KEYS = ["iteration", "yjsClient"] as const;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/;

type GatewayEventRecord = EventRecord & {
  correlation: EventCorrelation & { gatewayCallId: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!parts) return undefined;

  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return undefined;
  const [, year, month, day, hour, minute, second] = parts;
  return timestamp.getUTCFullYear() === Number(year) &&
    timestamp.getUTCMonth() + 1 === Number(month) &&
    timestamp.getUTCDate() === Number(day) &&
    timestamp.getUTCHours() === Number(hour) &&
    timestamp.getUTCMinutes() === Number(minute) &&
    timestamp.getUTCSeconds() === Number(second)
    ? timestamp.toISOString()
    : undefined;
}

function isEventLevel(value: unknown): value is EventLevel {
  return (
    value === "trace" ||
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error" ||
    value === "fatal"
  );
}

function normalizeCorrelation(value: unknown): GatewayEventRecord["correlation"] | undefined {
  if (!isRecord(value)) return undefined;

  const normalized: Record<string, string | number> = {};
  for (const key of CORRELATION_STRING_KEYS) {
    if (typeof value[key] === "string") normalized[key] = value[key];
  }
  for (const key of CORRELATION_NUMBER_KEYS) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) {
      normalized[key] = value[key];
    }
  }

  const gatewayCallId = normalized.gatewayCallId;
  return typeof gatewayCallId === "string" && gatewayCallId.length > 0
    ? { ...normalized, gatewayCallId }
    : undefined;
}

function normalizeStream(value: unknown): TraceStreamRef | undefined {
  if (
    !isRecord(value) ||
    typeof value.streamId !== "string" ||
    (value.transport !== "thread" && value.transport !== "yjs" && value.transport !== "gateway") ||
    (value.observedAt !== "client" && value.observedAt !== "server") ||
    typeof value.observerSeq !== "number" ||
    !Number.isFinite(value.observerSeq)
  ) {
    return undefined;
  }

  const direction =
    value.direction === "client_to_server" || value.direction === "server_to_client"
      ? value.direction
      : undefined;
  return {
    streamId: value.streamId,
    transport: value.transport,
    observedAt: value.observedAt,
    observerSeq: value.observerSeq,
    ...(direction ? { direction } : {}),
    ...(typeof value.messageClass === "string" ? { messageClass: value.messageClass } : {}),
    ...(typeof value.bytes === "number" && Number.isFinite(value.bytes)
      ? { bytes: value.bytes }
      : {}),
  };
}

function normalizeGatewayRecord(value: unknown): GatewayEventRecord | undefined {
  if (
    !isRecord(value) ||
    value.source !== "gateway" ||
    typeof value.name !== "string" ||
    !isEventLevel(value.level) ||
    !isRecord(value.payload)
  ) {
    return undefined;
  }

  const timestamp = normalizeTimestamp(value.timestamp);
  const correlation = normalizeCorrelation(value.correlation);
  if (!timestamp || !correlation) return undefined;

  const stream = normalizeStream(value.stream);
  return {
    ...(typeof value.eventId === "string" ? { eventId: value.eventId } : {}),
    timestamp,
    level: value.level,
    source: value.source,
    name: value.name,
    ...(value.sensitivity === "safe" || value.sensitivity === "protected_reference"
      ? { sensitivity: value.sensitivity }
      : {}),
    correlation,
    ...(stream ? { stream } : {}),
    payload: value.payload,
  };
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function terminalChunkCounts(record: EventRecord | undefined): Map<string, number> | undefined {
  const value = record?.payload.chunkCounts;
  if (!isRecord(value)) return undefined;

  const counts = new Map<string, number>();
  for (const [messageClass, count] of Object.entries(value)) {
    if (typeof count === "number" && Number.isInteger(count) && count > 0) {
      counts.set(messageClass, count);
    }
  }
  return counts.size > 0 ? counts : undefined;
}

function terminalOutcome(record: EventRecord): Exclude<LlmCallOutcome, "in-flight"> | undefined {
  if (record.name !== "stream.close") return undefined;
  const outcome = record.payload.outcome;
  return outcome === "ok" || outcome === "cancelled" || outcome === "error" ? outcome : "error";
}

function compareEvents(left: EventRecord, right: EventRecord): number {
  const byTimestamp = left.timestamp.localeCompare(right.timestamp);
  if (byTimestamp !== 0) return byTimestamp;
  return (left.stream?.observerSeq ?? 0) - (right.stream?.observerSeq ?? 0);
}

function valueFromLastCorrelation<
  K extends "provider" | "model" | "threadId" | "turnId" | "iteration" | "agentSlug",
>(events: readonly EventRecord[], key: K): NonNullable<EventRecord["correlation"]>[K] | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const value = events[index]?.correlation?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function deriveCall(gatewayCallId: string, records: readonly EventRecord[]): LlmCallSummary {
  const events = [...records].sort(compareEvents);
  const lifecycleEvents = events.filter((record) => record.name !== "stream.chunk");
  const terminalRecords = events
    .filter((record) => terminalOutcome(record) !== undefined)
    .sort((left, right) => {
      const leftOutcome = terminalOutcome(left);
      const rightOutcome = terminalOutcome(right);
      if (!leftOutcome || !rightOutcome) return 0;
      const byPrecedence = OUTCOME_PRECEDENCE[rightOutcome] - OUTCOME_PRECEDENCE[leftOutcome];
      return byPrecedence !== 0 ? byPrecedence : compareEvents(right, left);
    });
  const terminal = terminalRecords[0];
  const outcome = terminal ? (terminalOutcome(terminal) ?? "in-flight") : "in-flight";
  const chunksByClass = terminalChunkCounts(terminal) ?? new Map<string, number>();

  if (chunksByClass.size === 0) {
    for (const record of events) {
      if (record.name !== "stream.chunk") continue;
      const messageClass = record.stream?.messageClass ?? "unknown";
      chunksByClass.set(messageClass, (chunksByClass.get(messageClass) ?? 0) + 1);
    }
  }

  const chunks = [...chunksByClass.entries()]
    .map(([messageClass, count]) => ({ messageClass, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.messageClass.localeCompare(right.messageClass),
    );
  const firstEvent = events[0];
  const lastEvent = events.at(-1);

  return {
    gatewayCallId,
    startedAt: firstEvent?.timestamp ?? "",
    lastEventAt: lastEvent?.timestamp ?? "",
    provider: valueFromLastCorrelation(events, "provider"),
    model: valueFromLastCorrelation(events, "model"),
    outcome,
    ...(typeof terminal?.payload.errorCode === "string"
      ? { errorCode: terminal.payload.errorCode }
      : {}),
    // Close-record names are the gateway's: provider timing is null when no result arrived,
    // while the observation duration is always present.
    firstOutputMs: optionalNumber(terminal?.payload.providerFirstOutputMs),
    durationMs: optionalNumber(terminal?.payload.gatewayObservationDurationMs),
    inputTokens: optionalNumber(terminal?.payload.inputTokens),
    outputTokens: optionalNumber(terminal?.payload.outputTokens),
    threadId: valueFromLastCorrelation(events, "threadId"),
    turnId: valueFromLastCorrelation(events, "turnId"),
    iteration: valueFromLastCorrelation(events, "iteration"),
    agentSlug: valueFromLastCorrelation(events, "agentSlug"),
    lifecycleEvents,
    chunks,
    chunkCount:
      optionalNumber(terminal?.payload.chunkCount) ??
      chunks.reduce((total, chunk) => total + chunk.count, 0),
  };
}

/** Group valid gateway records by call id and return newest calls first. */
export function deriveLlmCalls(records: unknown): LlmCallSummary[] {
  const recordsByCall = new Map<string, EventRecord[]>();

  if (!Array.isArray(records)) return [];

  for (const candidate of records) {
    const record = normalizeGatewayRecord(candidate);
    if (!record) continue;
    const gatewayCallId = record.correlation.gatewayCallId;
    const callRecords = recordsByCall.get(gatewayCallId);
    if (callRecords) callRecords.push(record);
    else recordsByCall.set(gatewayCallId, [record]);
  }

  return [...recordsByCall.entries()]
    .map(([gatewayCallId, callRecords]) => deriveCall(gatewayCallId, callRecords))
    .sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) ||
        right.lastEventAt.localeCompare(left.lastEventAt) ||
        right.gatewayCallId.localeCompare(left.gatewayCallId),
    );
}
