/**
 * Pure per-tool visibility policy shared by tool-row rendering and fold digests.
 * Protocol blocks stay hidden when a custom card is the sole writer-facing
 * surface: a successful ask (the takeover, then the asking turn's receipt), spawn and a foreground thread_message
 * that ran (helper-result card). A queued or failed thread_message shows as a
 * row once it settles; `partitionTurn` hides a failed one whose helper card is
 * in the turn. A child return_result is rendered as the child's report.
 * Reads the typed `tool.result`, never the model's `tool.output` text.
 */
import { isNotesStepHeldResult } from "@meridian/contracts/threads";
import type { ToolView } from "./group-delivery-segments";
import { threadMessageRow } from "./thread-message-result";

export function isToolViewVisible(tool: ToolView): boolean {
  if (isNotesStepHeldResult(tool.result)) return true;
  // A failed call made no ask, so no takeover or receipt stands in for its row.
  if (tool.toolName === "ask_user") return tool.isError;
  if (tool.toolName === "spawn") return false;
  if (tool.toolName === "thread_message") return threadMessageRow(tool) !== null;
  return true;
}
