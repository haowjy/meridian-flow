import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";
import { stringInput, toolInputObject } from "./tool-command";

type QueuedThreadMessage = {
  handle: string;
  name: string | null;
};

type ThreadMessageRow =
  | { kind: "queued"; message: QueuedThreadMessage }
  | { kind: "failed"; handle: string | null };

export function threadMessageRow(tool: ToolView): ThreadMessageRow | null {
  if (tool.toolName !== "thread_message" || tool.status === "partial") return null;
  const queued = parseQueuedThreadMessage(tool.result);
  if (queued) return { kind: "queued", message: queued };
  if (tool.isError || statusOf(tool.result) === "error") {
    return { kind: "failed", handle: stringInput(toolInputObject(tool), "ref") ?? null };
  }
  return null;
}

function parseQueuedThreadMessage(value: JsonValue | null): QueuedThreadMessage | null {
  if (!isRecord(value) || value.status !== "background") return null;
  if (typeof value.handle !== "string" || value.handle.length === 0) return null;
  if ("execution" in value) return null;
  return { handle: value.handle, name: typeof value.name === "string" ? value.name : null };
}

function statusOf(value: JsonValue | null): unknown {
  return isRecord(value) ? value.status : undefined;
}

function isRecord(value: JsonValue | null): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
