/** Pure projection from gateway EventRecords into the LLM Calls dashboard model. */
import type { EventRecord } from "@meridian/contracts/observability";

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

const OUTCOME_PRECEDENCE: Record<Exclude<LlmCallOutcome, "in-flight">, number> = {
  ok: 0,
  cancelled: 1,
  error: 2,
};

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function terminalOutcome(record: EventRecord): Exclude<LlmCallOutcome, "in-flight"> | undefined {
  if (record.name !== "stream.close") return undefined;
  const outcome = record.payload.outcome;
  return outcome === "ok" || outcome === "cancelled" || outcome === "error" ? outcome : undefined;
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
  const firstOutputRecord = events.find((record) => record.name === "stream.first_output");
  const chunksByClass = new Map<string, number>();

  for (const record of events) {
    if (record.name !== "stream.chunk") continue;
    const messageClass = record.stream?.messageClass ?? "unknown";
    chunksByClass.set(messageClass, (chunksByClass.get(messageClass) ?? 0) + 1);
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
    firstOutputMs:
      optionalNumber(terminal?.payload.firstOutputMs) ??
      optionalNumber(firstOutputRecord?.payload.latencyMs),
    durationMs: optionalNumber(terminal?.payload.durationMs),
    inputTokens: optionalNumber(terminal?.payload.inputTokens),
    outputTokens: optionalNumber(terminal?.payload.outputTokens),
    threadId: valueFromLastCorrelation(events, "threadId"),
    turnId: valueFromLastCorrelation(events, "turnId"),
    iteration: valueFromLastCorrelation(events, "iteration"),
    agentSlug: valueFromLastCorrelation(events, "agentSlug"),
    lifecycleEvents,
    chunks,
    chunkCount: chunks.reduce((total, chunk) => total + chunk.count, 0),
  };
}

/** Group gateway records by call id and return newest calls first. */
export function deriveLlmCalls(records: readonly EventRecord[]): LlmCallSummary[] {
  const recordsByCall = new Map<string, EventRecord[]>();

  for (const record of records) {
    const gatewayCallId = record.correlation?.gatewayCallId;
    if (record.source !== "gateway" || !gatewayCallId) continue;
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
