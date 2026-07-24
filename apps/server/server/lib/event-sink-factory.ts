/**
 * Event-sink factory: resolves Meridian's local observability sink. The default
 * local backend always writes stdout and mirrors to JSONL only when LOG_DIR is set.
 */
import {
  createLocalEventSink,
  createNoopEventSink,
  createTeeEventSink,
  type EventQuery,
  type EventSink,
  RecentEventsBuffer,
} from "../domains/observability/index.js";
import { resolveRecentEventsEnabled } from "./env.js";

const DEFAULT_LOG_RETENTION_DAYS = 14;

function localLogRetentionDays(): number {
  const raw = process.env.LOG_RETENTION_DAYS;
  if (!raw) return DEFAULT_LOG_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`LOG_RETENTION_DAYS must be a positive integer; received ${raw}`);
  }
  return parsed;
}

export interface EventSinkComposition {
  sink: EventSink;
  eventQuery?: EventQuery;
}

export function createEventSinkFromEnv(): EventSinkComposition {
  const provider = process.env.EVENT_PROVIDER ?? "local";
  if (provider === "none" || provider === "noop") return { sink: createNoopEventSink() };
  if (provider === "local") {
    const dir = process.env.LOG_DIR || undefined;
    const local = createLocalEventSink({
      dir,
      retentionDays: dir ? localLogRetentionDays() : undefined,
    });
    if (!resolveRecentEventsEnabled({ rawNodeEnv: process.env.NODE_ENV })) {
      return { sink: local };
    }
    const eventQuery = new RecentEventsBuffer();
    return { sink: createTeeEventSink([local, eventQuery]), eventQuery };
  }
  throw new Error(`Unsupported EVENT_PROVIDER: ${provider}`);
}
