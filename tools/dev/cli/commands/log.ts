/** `./mf log`: recent server observability records (dev-only route), optionally followed. */
import { usageError } from "../cli-error";
import {
  type CommandSpec,
  durationOption,
  flag,
  intOption,
  parseDuration,
  stringOption,
} from "../command";
import { oneLine, truncate } from "../output";

const FILTERS: Record<string, string> = {
  event: "eventId",
  source: "source",
  name: "name",
  level: "level",
  trace: "traceId",
  thread: "threadId",
  turn: "turnId",
  document: "documentId",
  "error-code": "errorCode",
};

type EventRecord = {
  eventId?: string;
  timestamp?: string;
  level?: string;
  source?: string;
  name?: string;
  correlation?: Record<string, unknown>;
  payload?: unknown;
};

type EventQueryResponse = { events?: EventRecord[]; dropped?: number; droppedBytes?: number };

/** `10m`/`30s` become a timestamp relative to now; ISO timestamps pass through. */
export function sinceTimestamp(raw: string, now = Date.now()): string {
  if (/^\d+(ms|s|m|h)$/.test(raw))
    return new Date(now - parseDuration(raw, "--since")).toISOString();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime()))
    throw usageError("--since must be a duration (10m) or ISO timestamp");
  return parsed.toISOString();
}

function compact(event: EventRecord, full: boolean): EventRecord {
  if (full) return event;
  const { payload: _payload, ...rest } = event;
  return rest;
}

function renderLine(event: EventRecord, full: boolean): string {
  const correlation = Object.entries(event.correlation ?? {})
    .filter(([key]) => ["threadId", "turnId", "traceId", "toolName", "errorCode"].includes(key))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const payload =
    full && event.payload !== undefined
      ? ` ${truncate(oneLine(JSON.stringify(event.payload)), 400)}`
      : "";
  return `${event.timestamp ?? "?"} ${(event.level ?? "?").padEnd(5)} ${event.source ?? "?"} ${event.name ?? "?"}${correlation ? ` ${correlation}` : ""}${payload}`;
}

export const logCommand: CommandSpec = {
  path: ["log"],
  summary: "Recent server events (filter by thread/turn/trace/level), --follow to poll",
  route: "GET /api/debug/events",
  options: {
    ...Object.fromEntries(
      Object.keys(FILTERS).map((name) => [
        name,
        { type: "string" as const, description: `Filter by ${FILTERS[name]}` },
      ]),
    ),
    since: { type: "string", description: "Only newer than a duration (10m) or ISO time" },
    limit: { type: "string", description: "Max records per query (default 50)" },
    full: { type: "boolean", description: "Include payloads" },
    follow: { type: "boolean", short: "f", description: "Keep polling for new records" },
    timeout: { type: "string", description: "Stop following after this long (default 10m)" },
  },
  examples: [
    "./mf log --thread <id>",
    "./mf log --level error --since 10m",
    "./mf log --trace <traceId> --full --json",
  ],
  async run(ctx) {
    const search = new URLSearchParams();
    for (const [flagName, key] of Object.entries(FILTERS)) {
      const value = stringOption(ctx, flagName);
      if (value !== undefined) search.set(key, value);
    }
    const since = stringOption(ctx, "since");
    if (since !== undefined) search.set("sinceTimestamp", sinceTimestamp(since));
    const limit = intOption(ctx, "limit", 50);
    if (limit > 0) search.set("limit", String(limit));
    const full = flag(ctx, "full");
    const follow = flag(ctx, "follow");
    const session = await ctx.session();
    const query = async (cursor?: string) => {
      const params = new URLSearchParams(search);
      if (cursor) params.set("sinceEventId", cursor);
      return session.request<EventQueryResponse>("GET", `/api/debug/events?${params}`);
    };

    const first = await query();
    const events = first.events ?? [];
    if (!follow) {
      ctx.out.result(
        {
          events: events.map((event) => compact(event, full)),
          droppedRecords: first.dropped ?? 0,
          droppedBytes: first.droppedBytes ?? 0,
        },
        (value) =>
          value.events.length === 0
            ? "(no matching events)"
            : value.events.map((event) => renderLine(event, full)).join("\n"),
      );
      return undefined;
    }

    const deadlineAt = Date.now() + durationOption(ctx, "timeout", 10 * 60_000);
    let cursor: string | undefined;
    const emit = (batch: EventRecord[]) => {
      for (const event of batch) {
        ctx.out.record({ ...compact(event, full) }, renderLine(event, full), "out");
        if (event.eventId) cursor = event.eventId;
      }
    };
    emit(events);
    while (Date.now() < deadlineAt) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      emit((await query(cursor)).events ?? []);
    }
    return undefined;
  },
};
