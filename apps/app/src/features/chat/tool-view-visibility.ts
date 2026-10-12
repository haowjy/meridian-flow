/**
 * Pure per-tool visibility policy shared by tool-row rendering and fold digests.
 * Protocol blocks stay hidden when a custom card is the sole writer-facing
 * surface: ask_user (interrupt card), spawn and a foreground thread_message
 * that ran (helper-result card). A queued or failed thread_message shows as a
 * row once it settles; `partitionTurn` hides a failed one whose helper card is
 * in the turn. A child return_result is rendered as the child's report.
 * Reads the typed `tool.result`, never the model's `tool.output` text.
 */
import type { JsonValue } from "@meridian/contracts/protocol";
import type { ToolView } from "./group-delivery-segments";
import { threadMessageRow } from "./thread-message-result";

export function isToolViewVisible(tool: ToolView): boolean {
  if (tool.toolName === "ask_user") return false;
  if (tool.toolName === "spawn") return false;
  if (tool.toolName === "thread_message") return threadMessageRow(tool) !== null;
  if (tool.toolName === "tool" && isInterruptResult(tool.result)) return false;
  return true;
}

function isInterruptResult(result: JsonValue | null): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const record = result as Record<string, JsonValue>;
  return "provenance" in record && "value" in record;
}
