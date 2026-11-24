import {
  type AgentEditResultV1,
  agentEditResultSummary,
  isAgentEditResultEnvelope,
} from "@meridian/agent-edit";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";

const object = (value: JsonValue | undefined) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

export function documentHistorySummary(input: JsonObject, result: JsonValue): string | undefined {
  if (!isAgentEditResultEnvelope(result)) return undefined;
  const words =
    typeof input.content === "string"
      ? input.content.trim().split(/\s+/u).filter(Boolean).length
      : undefined;
  return agentEditResultSummary(result as unknown as AgentEditResultV1, words) || undefined;
}

export function spawnHistorySummary(_input: JsonObject, result: JsonValue): string | undefined {
  const typed = object(result);
  const handle = typed?.handle ?? object(typed?.report)?.handle;
  return typeof handle === "string" ? handle : undefined;
}

export function threadHistorySummary(input: JsonObject, result: JsonValue): string | undefined {
  if (input.ref !== undefined && input.ref !== "current") return undefined;
  const ref = object(result)?.ref;
  return typeof ref === "string" ? ref : undefined;
}

export function workHistorySummary(input: JsonObject, result: JsonValue): string | undefined {
  if (input.command === "list" && Array.isArray(result))
    return `${result.length} ${result.length === 1 ? "Work" : "Works"}`;
  if (input.command !== "create" && input.command !== "switch") return undefined;
  const handle = object(result)?.handle;
  return typeof handle === "string" ? handle : undefined;
}
