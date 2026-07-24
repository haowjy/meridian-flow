/**
 * EventSink call-site helpers: timestamp stamping and JSON-natural error payloads
 * for observability records. Keeps emit shape consistent across domain migrations.
 */
import { isMeridianError, meridianErrorToJson } from "@meridian/contracts/interrupt";
import type { EventRecord, EventSink } from "./ports/event-sink.js";

const PG_QUERY_MAX = 1000;

/**
 * Pull the Postgres wire diagnostics off a postgres-js error so a driver failure
 * stops surfacing as a bare "Failed query". postgres-js exposes these as
 * snake_case fields plus a (non-enumerable, so spread-invisible) `query`; we read
 * them by name. Returns null when the error is not pg-shaped. Never throws — a
 * serializer must not mask the error it is reporting.
 */
function postgresErrorFields(error: Error): Record<string, unknown> | null {
  const pg = error as Error & Record<string, unknown>;
  if (typeof pg.code !== "string" || pg.severity === undefined) return null;
  const fields: Record<string, unknown> = { code: pg.code, severity: pg.severity };
  const optional: ReadonlyArray<readonly [string, string]> = [
    ["detail", "detail"],
    ["hint", "hint"],
    ["constraint", "constraint_name"],
    ["column", "column_name"],
    ["table", "table_name"],
  ];
  for (const [key, source] of optional) {
    if (pg[source] !== undefined) fields[key] = pg[source];
  }
  const query = pg.query;
  if (typeof query === "string") {
    fields.query = query.length > PG_QUERY_MAX ? `${query.slice(0, PG_QUERY_MAX)}…` : query;
  }
  return fields;
}

export function unknownToEventPayload(error: unknown): Record<string, unknown> {
  if (isMeridianError(error)) {
    return { error: meridianErrorToJson(error) };
  }
  if (error instanceof Error) {
    const payload: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    const postgres = postgresErrorFields(error);
    if (postgres) payload.postgres = postgres;
    if (error.cause !== undefined) {
      payload.cause = unknownToEventPayload(error.cause);
    }
    return payload;
  }
  return { error };
}

export function emitEvent(
  sink: EventSink,
  event: Omit<EventRecord, "timestamp"> & { timestamp?: string },
): void {
  sink.emit({
    ...event,
    eventId: event.eventId ?? crypto.randomUUID(),
    timestamp: event.timestamp ?? new Date().toISOString(),
  });
}
