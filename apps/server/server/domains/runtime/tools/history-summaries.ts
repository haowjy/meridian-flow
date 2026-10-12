/**
 * What follows a finished call's `→` in a `thread_history` line (D48), read
 * from the call's typed result, never its rendered text (D43). The call's
 * arguments are already on the line, so a summary adds only what came of it.
 */
import {
  type AgentEditResultV1,
  agentEditResultSummary,
  isAgentEditResultEnvelope,
} from "@meridian/agent-edit";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

const object = (value: JsonValue | undefined) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

/** `read` and `write`: the agent-edit receipt in brief, with the words a write sent. */
export function documentHistorySummary(input: JsonObject, result: JsonValue): string | undefined {
  if (!isAgentEditResultEnvelope(result)) return undefined;
  const words =
    typeof input.content === "string"
      ? input.content.trim().split(/\s+/u).filter(Boolean).length
      : undefined;
  return agentEditResultSummary(result as unknown as AgentEditResultV1, words) || undefined;
}

/** `spawn` and `thread_message`: the child's handle. */
export function spawnHistorySummary(_input: JsonObject, result: JsonValue): string | undefined {
  const typed = object(result);
  const handle = typed?.handle ?? object(typed?.report)?.handle;
  return typeof handle === "string" ? handle : undefined;
}

/** `thread_ls`, `thread_history`, `thread_report`: the conversation, when the call didn't name it. */
export function threadHistorySummary(input: JsonObject, result: JsonValue): string | undefined {
  if (input.ref !== undefined && input.ref !== "current") return undefined;
  const ref = object(result)?.ref;
  return typeof ref === "string" ? ref : undefined;
}

/** `work`: how many Works a listing found, or the Work a create made. */
export function workHistorySummary(input: JsonObject, result: JsonValue): string | undefined {
  if (input.command === "list" && Array.isArray(result))
    return `${result.length} ${result.length === 1 ? "Work" : "Works"}`;
  if (input.command !== "create") return undefined;
  const slug = object(result)?.slug;
  return typeof slug === "string" ? `@${slug}` : slug === null ? "@/" : undefined;
}
