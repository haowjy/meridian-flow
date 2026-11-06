/** Why a tool call failed, as a failed row says it: localized for codes the app knows. */

import { t } from "@lingui/core/macro";
import {
  meridianErrorFromStructuredToolOutput,
  TOOL_EXCEPTION_CODE,
} from "@meridian/contracts/protocol";
import type { ToolView } from "@meridian/thread-client";
import type { ToolExpand } from "./tool-renderers";

/** Why a call failed, for a failed row whose renderer has nothing else to open. */
export function errorMessageExpand(tool: ToolView): ToolExpand | null {
  if (!tool.isError || tool.result == null) return null;
  const text = failureText(tool.result);
  if (!text) return null;
  return () => <div className="text-compact text-destructive">{text}</div>;
}

/** A schema failure, or arguments that weren't JSON: either way the model's mistake. */
const INVALID_ARGUMENTS = () => t`The assistant called this tool with arguments it couldn't use.`;

/**
 * A refusal's own message, localized where the app knows the code. A caught exception
 * (`TOOL_EXCEPTION_CODE`) can carry SQL or internal ids, so it reads as generic copy.
 */
function failureText(result: NonNullable<ToolView["result"]>): string {
  const record =
    typeof result === "object" && !Array.isArray(result) ? (result as { error?: unknown }) : null;
  if (record?.error === "invalid_arguments") return INVALID_ARGUMENTS();
  if (record?.error === "permission_denied") return t`The assistant can't use this tool here.`;
  // Spawn and thread_message refusals nest their error under `error`.
  const nested = record?.error && typeof record.error === "object" ? record.error : null;
  const error = meridianErrorFromStructuredToolOutput((nested ?? result) as typeof result);
  switch (error.code) {
    case "tool_arguments_parse":
      return INVALID_ARGUMENTS();
    case TOOL_EXCEPTION_CODE:
      return t`Something went wrong while running this.`;
    case "tool_timeout":
      return t`This took too long, so it was stopped.`;
    case "thread_stopped":
      return t`A chat was stopped, so this wasn't sent.`;
    case "one_request_at_a_time":
      return t`Only one question or request can wait for an answer at a time, so this one wasn't asked.`;
    case "permission_denied":
      // The action policy's refusals (a read-only agent, a subagent that can't ask) are
      // worded for the model; file-policy refusals keep their own message.
      return isActionDenied(error.details)
        ? t`This assistant isn't allowed to make this change, so it wasn't done.`
        : error.message;
    default:
      return error.message;
  }
}

function isActionDenied(details: unknown): boolean {
  return (
    typeof details === "object" &&
    details !== null &&
    (details as { reason?: unknown }).reason === "action_denied"
  );
}
