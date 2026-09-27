/** Normalized identity and lifecycle for every writer-facing subagent surface. */

import { parseInvocationCard } from "@meridian/contracts/components";
import type { Thread, Turn } from "@meridian/contracts/protocol";
import type { ThreadActivityNode } from "@meridian/contracts/threads";
import { subagentCurrentToolLabel } from "./display";
import { readSubagentUpdateMetadata } from "./update";

export type SubagentRunStatus = "running" | "done" | "stopped" | "unknown";
export type SubagentRun = {
  threadId: string | null;
  ref: string | null;
  execution: string | null;
  agentName: string;
  description: string | null;
  status: SubagentRunStatus;
  startedAt: string | null;
  endedAt: string | null;
  liveTool: string | null;
  originTurnId: string | null;
  parentThreadId: string | null;
  deliveryMode: "direct" | "background_notification" | null;
};

export type SubagentRunKey = { threadId: string } | { ref: string } | { execution: string };

/** A terminal activity observation wins over a stale persisted running card. */
export function statusFromSources(input: {
  savedRunning?: boolean;
  outcome?: unknown;
  live?: boolean;
  endedAt?: string | null;
}): SubagentRunStatus {
  if (input.outcome === "succeeded") return "done";
  if (input.outcome === "failed" || input.outcome === "cancelled") return "stopped";
  if (input.live) return "running";
  if (input.endedAt) return input.savedRunning ? "unknown" : "unknown";
  return input.savedRunning ? "unknown" : "unknown";
}

export function runFromActivity(node: ThreadActivityNode): SubagentRun {
  const live = node.status.kind === "awake";
  const status = statusFromSources({
    live,
    outcome:
      node.spawnStatus === "succeeded"
        ? "succeeded"
        : node.spawnStatus === "failed" || node.spawnStatus === "cancelled"
          ? node.spawnStatus
          : undefined,
    endedAt: node.runEndedAt,
  });
  return {
    threadId: node.threadId,
    ref: node.ref,
    execution: null,
    agentName: node.agentName?.trim() || "Subagent",
    description: node.title?.trim() || null,
    status,
    startedAt: node.runStartedAt ?? null,
    endedAt: node.runEndedAt ?? null,
    liveTool: node.currentTool
      ? subagentCurrentToolLabel(node.currentTool.toolName, node.currentTool.input)
      : null,
    originTurnId: node.originTurnId ?? null,
    parentThreadId: node.parentThreadId ?? null,
    deliveryMode: node.deliveryMode ?? null,
  };
}

export function runFromThread(
  thread: Thread,
  savedStatus: "running" | "succeeded" | "failed" | "cancelled" | null,
  startedAt?: string | null,
  endedAt?: string | null,
): SubagentRun {
  return {
    threadId: thread.id,
    ref: null,
    execution: null,
    agentName: thread.agentName?.trim() || "Subagent",
    description: thread.title?.trim() || null,
    status: statusFromSources({
      savedRunning: savedStatus === "running",
      outcome:
        savedStatus === "succeeded"
          ? savedStatus
          : savedStatus === "failed" || savedStatus === "cancelled"
            ? savedStatus
            : undefined,
      live: savedStatus === "running" && !endedAt,
      endedAt,
    }),
    startedAt: startedAt ?? null,
    endedAt: endedAt ?? null,
    liveTool: null,
    originTurnId: null,
    parentThreadId: thread.parentThreadId ?? null,
    deliveryMode: null,
  };
}

export function indexSubagentRuns(runs: Iterable<SubagentRun>) {
  const byThreadId = new Map<string, SubagentRun>();
  const byRef = new Map<string, SubagentRun>();
  const byExecution = new Map<string, SubagentRun>();
  for (const run of runs) {
    if (run.threadId) byThreadId.set(run.threadId, run);
    if (run.ref) byRef.set(run.ref, run);
    if (run.execution) byExecution.set(run.execution, run);
  }
  return { byThreadId, byRef, byExecution };
}

/** Combines durable invocation/notice identity with activity, with terminal cards authoritative. */
export function buildSubagentRuns(
  nodes: readonly ThreadActivityNode[],
  turns: readonly Turn[],
): SubagentRun[] {
  const byThread = new Map(nodes.map((node) => [node.threadId, runFromActivity(node)]));
  const runs = new Map<string, SubagentRun>();
  for (const turn of turns) {
    for (const block of turn.blocks) {
      const card = parseInvocationCard(block.content);
      if (card) {
        const live = byThread.get(card.childThreadId ?? "");
        const running = card.terminalAt === null;
        const status = statusFromSources({
          savedRunning: running,
          outcome: card.outcome,
          live: live?.status === "running",
          endedAt: live?.endedAt ?? card.terminalAt,
        });
        const run: SubagentRun = {
          threadId: card.childThreadId ?? null,
          ref: live?.ref ?? null,
          execution: card.execution ?? null,
          agentName: card.agentName || live?.agentName || "Subagent",
          description: card.title?.trim() || live?.description || null,
          status,
          startedAt: card.startedAt,
          endedAt: card.terminalAt ?? live?.endedAt ?? null,
          liveTool: live?.liveTool ?? null,
          originTurnId: turn.id,
          parentThreadId: turn.threadId,
          deliveryMode: card.deliveryMode,
        };
        runs.set(`execution:${card.execution ?? card.toolCallId}`, run);
        if (run.threadId) runs.set(`thread:${run.threadId}`, run);
        if (run.ref) runs.set(`ref:${run.ref}`, run);
      }
    }
    const update = readSubagentUpdateMetadata(turn.metadata);
    if (update) {
      const live = byThread.get(update.childThreadId);
      // The launch card came first; it keeps identity when activity is empty.
      const card = runs.get(`thread:${update.childThreadId}`);
      const run: SubagentRun = {
        threadId: update.childThreadId,
        ref: update.handle,
        execution: update.execution,
        agentName: update.agentName || live?.agentName || card?.agentName || "Subagent",
        description: live?.description ?? card?.description ?? null,
        status: statusFromSources({ outcome: update.outcome }),
        startedAt: live?.startedAt ?? card?.startedAt ?? null,
        endedAt: turn.completedAt ?? live?.endedAt ?? null,
        liveTool: null,
        originTurnId: live?.originTurnId ?? card?.originTurnId ?? null,
        parentThreadId: turn.threadId,
        deliveryMode: live?.deliveryMode ?? card?.deliveryMode ?? null,
      };
      runs.set(`thread:${run.threadId}`, run);
      runs.set(`ref:${run.ref}`, run);
      if (run.execution) runs.set(`execution:${run.execution}`, run);
    }
  }
  for (const [threadId, live] of byThread)
    if (!runs.has(`thread:${threadId}`)) runs.set(`thread:${threadId}`, live);
  return [...new Set(runs.values())];
}
