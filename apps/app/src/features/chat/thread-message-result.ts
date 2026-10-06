/**
 * Reads a `thread_message` call's typed `result` into its fold row.
 * A queued message (background mode) has no card, so its row is the writer's
 * only sign of it. A foreground re-task that ran is shown by its helper card.
 * A failed call gets a row; when the turn holds its helper card (a busy
 * target), `partitionTurn` hides the row and the card stands alone.
 *
 * `tool.output` is the model's text and is never parsed here.
 */
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";
import { stringInput, toolInputObject } from "./tool-command";

type QueuedThreadMessage = {
  /** The model-facing ref the message was sent to (`pN`). */
  handle: string;
};

type ThreadMessageRow =
  | { kind: "queued"; message: QueuedThreadMessage }
  | { kind: "failed"; handle: string | null };

/** The writer-facing row for a queued or failed `thread_message`, or null when it ran in the foreground or is still running. */
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
  // A spawned background run carries `execution` and its own card.
  if ("execution" in value) return null;
  return { handle: value.handle };
}

function statusOf(value: JsonValue | null): unknown {
  return isRecord(value) ? value.status : undefined;
}

function isRecord(value: JsonValue | null): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
