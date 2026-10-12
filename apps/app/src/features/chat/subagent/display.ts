/** Shared writer-facing identity, outcome, and elapsed-time display for subagent runs. */

import { createElement, useSyncExternalStore } from "react";
import { i18n } from "@/lib/i18n";
import { liveToolActivityLabel } from "../command-descriptor";

export type SubagentVisualStatus = "running" | "done" | "stopped" | "unknown";

/** The agent's name leads every subagent surface; the run's task name follows it. */
type SubagentIdentity = { agentName?: string | null; title?: string | null };

export function resolveSubagentName(node: SubagentIdentity | null | undefined): string {
  return subagentMarkName(node?.agentName);
}

/** Marks identify the agent, while the adjacent display name may be a task title. */
export function subagentMarkName(agentName?: string | null): string {
  const name = agentName?.trim();
  return name && name !== "Subagent" ? name : i18n._("Subagent");
}

export function subagentStatus(outcome: unknown, running = false): SubagentVisualStatus {
  if (running) return "running";
  if (outcome === "succeeded") return "done";
  if (outcome === "failed" || outcome === "cancelled") return "stopped";
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

/** One shared clock cadence keeps every visible running duration in sync. */
export function useSubagentClock(): number {
  return useSyncExternalStore(subscribeClock, readClock, readClock);
}

/** A clock subscriber exists only while the represented run is still active. */
export function Elapsed({ startedAt }: { startedAt?: string | null }) {
  const now = useSubagentClock();
  return createElement("span", null, formatSubagentElapsed(startedAt, null, now));
}

let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();
function readClock(): number {
  return clockNow;
}
function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const subscriber of clockListeners) subscriber();
    }, 1000);
  }
  return () => {
    clockListeners.delete(listener);
    if (!clockListeners.size && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
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
  // The final report never renders as a tool row, so it has no row phrase.
  if (toolName === "return_result") return i18n._("Reporting back…");
  return liveToolActivityLabel(toolName, input);
}
