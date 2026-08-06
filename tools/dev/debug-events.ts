/** LLM-friendly authenticated query client for the current worktree's recent server events. */
import { pathToFileURL } from "node:url";
import { getAuthenticatedDebugJson } from "./debug-http-client";

type DebugQuery = {
  eventId?: string;
  source?: string;
  name?: string;
  level?: string;
  traceId?: string;
  threadId?: string;
  turnId?: string;
  documentId?: string;
  errorCode?: string;
  sinceTimestamp?: string;
  limit: number;
};

export type DebugEventsOptions = {
  query: DebugQuery;
  full: boolean;
};

const VALUE_FLAGS = new Map([
  ["--event", "eventId"],
  ["--source", "source"],
  ["--name", "name"],
  ["--level", "level"],
  ["--trace", "traceId"],
  ["--thread", "threadId"],
  ["--turn", "turnId"],
  ["--document", "documentId"],
  ["--error-code", "errorCode"],
  ["--since", "sinceTimestamp"],
] as const);
const PIVOT_KEYS = ["eventId", "traceId", "threadId", "turnId", "documentId", "errorCode"];

function usage(): string {
  return [
    "Usage: pnpm debug:events -- --trace <id> [filters]",
    "Pivots: --event --trace --thread --turn --document --error-code",
    "Filters: --source --name --level --since --limit --full",
  ].join("\n");
}

export function parseDebugEventsArgs(args: string[]): DebugEventsOptions {
  if (args[0] === "--") args = args.slice(1);
  const values: Record<string, string> = {};
  let full = false;
  let rawLimit: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    if (flag === "--full") {
      full = true;
      continue;
    }
    if (flag === "--limit") {
      rawLimit = args[++index];
      if (!rawLimit) throw new Error(`--limit requires a value\n${usage()}`);
      continue;
    }
    const key = VALUE_FLAGS.get(flag as never);
    if (!key) throw new Error(`Unknown argument: ${flag}\n${usage()}`);
    const value = args[++index];
    if (!value) throw new Error(`${flag} requires a value\n${usage()}`);
    values[key] = value;
  }
  if (!PIVOT_KEYS.some((key) => values[key])) {
    throw new Error(`A narrowing pivot is required.\n${usage()}`);
  }
  const requestedLimit = rawLimit === undefined ? (full ? 200 : 50) : Number(rawLimit);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  const maxLimit = full ? 200 : 50;
  return {
    full,
    query: { ...values, limit: Math.min(requestedLimit, maxLimit) },
  };
}

const EVENT_RESPONSE_BYTES = 2 * 1_024 * 1_024;

function compactEvent(value: unknown): Record<string, unknown> {
  const event = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    timestamp: event.timestamp ?? null,
    level: event.level ?? null,
    source: event.source ?? null,
    name: event.name ?? null,
    eventId: event.eventId ?? null,
    correlation: event.correlation ?? {},
  };
}

export async function queryDebugEvents(
  options: DebugEventsOptions,
  repoRoot?: string,
): Promise<Record<string, unknown>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query)) search.set(key, String(value));
  const parsed = (await getAuthenticatedDebugJson({
    path: `/api/debug/events?${search.toString()}`,
    maxResponseBytes: EVENT_RESPONSE_BYTES,
    repoRoot,
  })) as {
    events?: unknown[];
    dropped?: unknown;
    droppedBytes?: unknown;
  };
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  return {
    query: options.query,
    events: options.full ? events : events.map(compactEvent),
    droppedRecords: typeof parsed.dropped === "number" ? parsed.dropped : 0,
    droppedBytes: typeof parsed.droppedBytes === "number" ? parsed.droppedBytes : 0,
  };
}

async function main(): Promise<void> {
  try {
    const result = await queryDebugEvents(parseDebugEventsArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
