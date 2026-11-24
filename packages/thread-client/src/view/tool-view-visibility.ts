import { isNotesStepHeldResult } from "@meridian/contracts/threads";
import type { ToolView } from "./group-delivery-segments";
import { threadMessageRow } from "./thread-message-result";

export function isToolViewVisible(tool: ToolView): boolean {
  if (isNotesStepHeldResult(tool.result)) return true;
  if (tool.toolName === "ask_user") return tool.isError;
  if (tool.toolName === "spawn") return false;
  if (tool.toolName === "thread_message") return threadMessageRow(tool) !== null;
  return true;
}
