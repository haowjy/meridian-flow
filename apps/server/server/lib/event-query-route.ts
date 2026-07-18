/** Shared parsing and live matching for the recent-events HTTP and SSE routes. */

import { createError } from "nitro/h3";
import type { EventCorrelation, EventLevel, EventRecord } from "../domains/observability/index.js";
import { type EventQueryFilter, eventMatchesQueryFilter } from "../domains/observability/index.js";

export type EventQueryParameters = Record<string, string | string[] | undefined>;

const EVENT_LEVELS = new Set<EventLevel>(["trace", "debug", "info", "warn", "error", "fatal"]);

function badQuery(message: string): never {
  throw createError({ statusCode: 400, message });
}

type CorrelationParser = (value: string, key: keyof EventCorrelation) => string | number;
const parseStringCorrelation: CorrelationParser = (value) => value;
const parseNumberCorrelation: CorrelationParser = (value, key) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) badQuery(`${key} must be a number`);
  return parsed;
};
const correlationParsers = {
  traceId: parseStringCorrelation,
  runId: parseStringCorrelation,
  parentRunId: parseStringCorrelation,
  requestId: parseStringCorrelation,
  threadId: parseStringCorrelation,
  turnId: parseStringCorrelation,
  childRunId: parseStringCorrelation,
  agentSlug: parseStringCorrelation,
  iteration: parseNumberCorrelation,
  attemptId: parseStringCorrelation,
  provider: parseStringCorrelation,
  model: parseStringCorrelation,
  route: parseStringCorrelation,
  method: parseStringCorrelation,
  projectId: parseStringCorrelation,
  workId: parseStringCorrelation,
  toolName: parseStringCorrelation,
  toolCallId: parseStringCorrelation,
  errorCode: parseStringCorrelation,
  documentId: parseStringCorrelation,
  branchId: parseStringCorrelation,
  branchGeneration: parseNumberCorrelation,
  yjsClient: parseNumberCorrelation,
  yjsSpans: parseStringCorrelation,
} satisfies Record<keyof EventCorrelation, CorrelationParser>;

function singleValue(query: EventQueryParameters, key: string): string | undefined {
  const value = query[key];
  if (Array.isArray(value)) badQuery(`${key} must be supplied once`);
  return value;
}

export function parseEventQueryFilter(query: EventQueryParameters): EventQueryFilter {
  const source = singleValue(query, "source");
  const name = singleValue(query, "name");
  const rawLevel = singleValue(query, "level");
  const sinceEventId = singleValue(query, "sinceEventId");
  const rawSinceTimestamp = singleValue(query, "sinceTimestamp");
  const rawLimit = singleValue(query, "limit");

  if (rawLevel !== undefined && !EVENT_LEVELS.has(rawLevel as EventLevel)) {
    badQuery(`level must be one of ${[...EVENT_LEVELS].join(", ")}`);
  }

  let sinceTimestamp: string | undefined;
  if (rawSinceTimestamp !== undefined) {
    const parsed = new Date(rawSinceTimestamp);
    if (Number.isNaN(parsed.getTime())) badQuery("sinceTimestamp must be an ISO timestamp");
    sinceTimestamp = parsed.toISOString();
  }

  let limit: number | undefined;
  if (rawLimit !== undefined) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) badQuery("limit must be a positive integer");
    limit = Math.min(parsed, 1_000);
  }

  const correlationEntries: Array<[keyof EventCorrelation, string | number]> = [];
  for (const key of Object.keys(correlationParsers) as Array<keyof EventCorrelation>) {
    const value = singleValue(query, key);
    if (value !== undefined) correlationEntries.push([key, correlationParsers[key](value, key)]);
  }

  const correlation = Object.fromEntries(correlationEntries) as Partial<EventCorrelation>;
  return {
    ...(source !== undefined && { source }),
    ...(name !== undefined && { name }),
    ...(rawLevel !== undefined && { level: rawLevel as EventLevel }),
    ...(correlationEntries.length > 0 && { correlation }),
    ...(sinceEventId !== undefined && { sinceEventId }),
    ...(sinceTimestamp !== undefined && { sinceTimestamp }),
    ...(limit !== undefined && { limit }),
  };
}

export function eventMatchesLiveQueryFilter(event: EventRecord, filter: EventQueryFilter): boolean {
  return eventMatchesQueryFilter(event, filter);
}
