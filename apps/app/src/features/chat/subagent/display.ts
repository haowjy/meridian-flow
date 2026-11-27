import { createElement } from "react";
import { useClock } from "@/hooks/use-clock";
import { i18n } from "@/lib/i18n";
import { liveToolActivityLabel } from "../command-descriptor";
import type { SubagentRunStatus } from "./run-model";

type SubagentIdentity = { agentName?: string | null; title?: string | null };

export function resolveSubagentName(node: SubagentIdentity | null | undefined): string {
  return subagentMarkName(node?.agentName);
}

export function subagentMarkName(agentName?: string | null): string {
  const name = agentName?.trim();
  return name && name !== "Subagent" ? name : i18n._("Subagent");
}

export function subagentStatus(outcome: unknown, running = false): SubagentRunStatus {
  if (running) return "running";
  if (outcome === "succeeded") return "done";
  if (outcome === "failed" || outcome === "cancelled") return outcome;
  return "unknown";
}

export function formatSubagentElapsed(
  startedAt?: string | null,
  endedAt?: string | null,
  now = Date.now(),
): string {
  if (!startedAt) return "";
  const start = Date.parse(startedAt);
  const end = endedAt ? Date.parse(endedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function Elapsed({ startedAt }: { startedAt?: string | null }) {
  const now = useClock(1000);
  return createElement("span", null, formatSubagentElapsed(startedAt, null, now));
}

export function subagentCurrentToolLabel(toolName: string, input: unknown): string {
  if (toolName === "spawn") {
    const values =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null;
    const agent = typeof values?.agent === "string" ? values.agent.trim() : "";
    return i18n._("Waiting on {0}", { 0: agent || i18n._("Subagent") });
  }
  if (toolName === "return_result") return i18n._("Reporting back…");
  return liveToolActivityLabel(toolName, input);
}
