/** `thread events --child`: one child's status and current tool from each activity frame. */
import { oneLine, truncate } from "../../core/output";
import type { CliEvent } from "./events-map";
import { asRecord } from "./transcript";

export const ACTIVITY_EVENT = "meridian.subagent.activity";

/** One child's row from one activity frame. */
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

const TARGET_KEYS = ["uri", "path", "target", "query", "handle"] as const;

/** First address-like string in a tool's input, so a line says what the tool is working on. */
function toolTarget(input: unknown): string | null {
  const fields = asRecord(input);
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

/** The chosen child's row from an activity frame, or null when the frame lacks it. */
export function childActivity(event: CliEvent, child: string): ChildActivity | null {
  if (event.type !== "event" || event.name !== ACTIVITY_EVENT) return null;
  const children = asRecord(event.value).children;
  if (!Array.isArray(children)) return null;
  const node = children.map(asRecord).find((entry) => matchesChild(entry, child));
  if (!node) return null;
  const status = asRecord(node.status);
  const tool = asRecord(node.currentTool);
  return {
    type: "child.activity",
    seq: event.seq,
    childThreadId: String(node.threadId),
    childRef: typeof node.ref === "string" ? node.ref : null,
    status: String(status.kind ?? "unknown"),
    phase: typeof status.phase === "string" ? status.phase : null,
    spawnStatus: typeof node.spawnStatus === "string" ? node.spawnStatus : null,
    tool: typeof tool.toolName === "string" ? tool.toolName : null,
    target: toolTarget(tool.input),
  };
}

/** The `followThread` presenter for --child: drops everything but that child's rows. */
export function presentChild(
  child: string,
): (event: CliEvent) => { value: ChildActivity; line: string } | null {
  return (event) => {
    const activity = childActivity(event, child);
    return activity ? { value: activity, line: renderChildActivity(activity) } : null;
  };
}

export function renderChildActivity(activity: ChildActivity): string {
  const status = activity.phase ? `${activity.status}/${activity.phase}` : activity.status;
  const lifecycle = activity.spawnStatus ? ` (${activity.spawnStatus})` : "";
  const tool = activity.tool
    ? ` ${activity.tool}${activity.target ? ` ${truncate(oneLine(activity.target), 120)}` : ""}`
    : "";
  return `${activity.seq} ${activity.childRef ?? activity.childThreadId.slice(0, 8)} ${status}${lifecycle}${tool}`;
}
