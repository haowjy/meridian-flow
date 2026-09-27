/**
 * `thread events` filters: keep events by dotted type or custom event name, and
 * narrow `meridian.subagent.activity` frames to one descendant's status and tool.
 */
import { oneLine, truncate } from "../../core/output";
import { type CliEvent, renderEventLine } from "./events-map";

export const ACTIVITY_EVENT = "meridian.subagent.activity";

/** One descendant's row from one activity frame. */
export type ChildActivity = {
  type: "child.activity";
  seq: string;
  childThreadId: string;
  childRef: string | null;
  status: string;
  phase: string | null;
  spawnStatus: string | null;
  tool: string | null;
  target: string | null;
};

export type EventFilter = {
  /** Dotted CLI types (`tool.completed`) or custom names (`meridian.subagent.activity`). */
  names: string[] | null;
  /** Thread id, unique id prefix, or `pN` ref of one descendant. */
  child: string | null;
};

/** The dotted type, or the custom event's own name for pass-through `event` records. */
export function eventName(event: CliEvent): string {
  return event.type === "event" ? event.name : event.type;
}

const TARGET_KEYS = ["uri", "path", "target", "query", "handle"] as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First address-like string in a tool's input, so a line says what the tool is working on. */
function toolTarget(input: unknown): string | null {
  const fields = record(input);
  if (!fields) return null;
  for (const key of TARGET_KEYS) {
    if (typeof fields[key] === "string" && fields[key]) return fields[key] as string;
  }
  return null;
}

function matchesChild(node: Record<string, unknown>, child: string): boolean {
  const threadId = String(node.threadId ?? "");
  return (
    node.ref === child || threadId === child || (child.length >= 6 && threadId.startsWith(child))
  );
}

/** The chosen descendant's row from an activity frame, or null when the frame lacks it. */
export function childActivity(event: CliEvent, child: string): ChildActivity | null {
  if (event.type !== "event" || event.name !== ACTIVITY_EVENT) return null;
  const descendants = record(event.value)?.descendants;
  if (!Array.isArray(descendants)) return null;
  const node = descendants.map(record).find((entry) => entry && matchesChild(entry, child));
  if (!node) return null;
  const status = record(node.status);
  // currentTool is optional here so this reads frames from before and after it existed.
  const tool = record(node.currentTool);
  return {
    type: "child.activity",
    seq: event.seq,
    childThreadId: String(node.threadId),
    childRef: typeof node.ref === "string" ? node.ref : null,
    status: String(status?.kind ?? "unknown"),
    phase: typeof status?.phase === "string" ? status.phase : null,
    spawnStatus: typeof node.spawnStatus === "string" ? node.spawnStatus : null,
    tool: typeof tool?.toolName === "string" ? tool.toolName : null,
    target: toolTarget(tool?.input),
  };
}

/**
 * Applies the filter to one mapped event: null drops it; otherwise the record to
 * emit and its text line. Custom events asked for by name get a line of their own.
 */
export function applyEventFilter(
  event: CliEvent,
  filter: EventFilter,
  full: boolean,
): { value: Record<string, unknown>; line: string | null } | null {
  if (filter.child) {
    const activity = childActivity(event, filter.child);
    return activity ? { value: activity, line: renderChildActivity(activity) } : null;
  }
  if (filter.names && !filter.names.includes(eventName(event))) return null;
  const line =
    event.type === "event" && filter.names
      ? renderNamedEvent(event, full)
      : renderEventLine(event, full);
  return { value: event, line };
}

export function renderChildActivity(activity: ChildActivity): string {
  const status = activity.phase ? `${activity.status}/${activity.phase}` : activity.status;
  const lifecycle = activity.spawnStatus ? ` (${activity.spawnStatus})` : "";
  const tool = activity.tool
    ? ` ${activity.tool}${activity.target ? ` ${truncate(oneLine(activity.target), 120)}` : ""}`
    : "";
  return `${activity.seq} ${activity.childRef ?? activity.childThreadId.slice(0, 8)} ${status}${lifecycle}${tool}`;
}

/** Text line for a custom event the default renderer hides, shown once asked for by name. */
export function renderNamedEvent(event: CliEvent & { type: "event" }, full: boolean): string {
  const value = event.value === undefined ? "" : ` ${JSON.stringify(event.value)}`;
  return `${event.seq} ${event.name}${truncate(value, full ? Number.POSITIVE_INFINITY : 240)}`;
}
