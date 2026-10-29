/** Why a tool call failed, as a failed row says it: localized for codes the app knows. */

import { t } from "@lingui/core/macro";
import { meridianErrorFromStructuredToolOutput } from "@meridian/contracts/protocol";
import type { ToolView } from "@meridian/thread-client";
import type { ToolExpand } from "./tool-renderers";

/** Why a call failed, for a failed row whose renderer has nothing else to open. */
export function errorMessageExpand(tool: ToolView): ToolExpand | null {
  if (!tool.isError || tool.result == null) return null;
  const text = failureText(tool.result);
  if (!text) return null;
  return () => <div className="text-compact text-destructive">{text}</div>;
}

/**
 * A refusal's own message for a domain code, localized where the app knows the code. An
 * unexpected error (`tool_error`) can carry SQL or internal ids, so it reads as generic copy.
 */
function failureText(result: NonNullable<ToolView["result"]>): string {
  const record =
    typeof result === "object" && !Array.isArray(result) ? (result as { error?: unknown }) : null;
  if (record?.error === "invalid_arguments")
    return t`The assistant called this tool with arguments it couldn't use.`;
  // Spawn and thread_message refusals nest their error under `error`.
  const nested = record?.error && typeof record.error === "object" ? record.error : null;
  const error = meridianErrorFromStructuredToolOutput((nested ?? result) as typeof result);
  switch (error.code) {
    case "tool_error":
      return t`Something went wrong while running this.`;
    case "thread_stopped":
      return t`A chat was stopped, so this wasn't sent.`;
    case "one_request_at_a_time":
      return t`Only one question can wait for an answer at a time, so this one wasn't asked.`;
    default:
      return error.message;
  }
}
