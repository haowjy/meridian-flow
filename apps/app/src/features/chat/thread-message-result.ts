/**
 * Reads a `thread_message` call that queued its message (background mode).
 * A foreground re-task is shown by its helper card; a queued one has no card,
 * so its tool row is the writer's only sign of it.
 *
 * `thread_message` has no text renderer: its `output` is the typed spawn result
 * (`status: "background"`), not model prose, so it is read here alongside a
 * `result` a future renderer would keep.
 */
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";
import { stringInput, toolInputObject } from "./tool-command";

export type QueuedThreadMessage = {
  /** The model-facing ref the message was sent to (`pN`). */
  handle: string;
  /** The caller re-tasked its own child and will be told when that run finishes. */
  notifiesCaller: boolean;
};

export type ThreadMessageRow =
  | { kind: "queued"; message: QueuedThreadMessage }
  | { kind: "failed"; handle: string | null };

/** The writer-facing row for a background `thread_message`, or null when a card stands in or it is still running. */
export function threadMessageRow(tool: ToolView): ThreadMessageRow | null {
  if (tool.toolName !== "thread_message" || tool.status === "partial") return null;
  const typed = tool.result ?? tool.output;
  const queued = parseQueuedThreadMessage(typed);
  if (queued) return { kind: "queued", message: queued };
  const input = toolInputObject(tool);
  // Mode defaults to background. A failed foreground call may still own a
  // card (the child ran and failed), and its transcript output no longer says
  // which, so only background failures get this row.
  if (stringInput(input, "mode") === "foreground") return null;
  if (tool.isError || statusOf(typed) === "error") {
    return { kind: "failed", handle: stringInput(input, "ref") ?? null };
  }
  return null;
}

export function parseQueuedThreadMessage(value: JsonValue | null): QueuedThreadMessage | null {
  if (!isRecord(value) || value.status !== "background") return null;
  if (typeof value.handle !== "string" || value.handle.length === 0) return null;
  // A spawned background run carries `execution` and its own card.
  if ("execution" in value) return null;
  return { handle: value.handle, notifiesCaller: value.notifiesCaller === true };
}

function statusOf(value: JsonValue | null): unknown {
  return isRecord(value) ? value.status : undefined;
}

function isRecord(value: JsonValue | null): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
