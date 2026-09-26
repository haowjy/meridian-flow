/** Compact projections of thread snapshots for `thread view` / `thread list` (text + JSON). */
import type { ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { type Block, blockPlainText, type Thread, type Turn } from "@meridian/contracts/threads";
import { oneLine, truncate } from "./output";

export type TranscriptLimits = { full: boolean };

export type CompactBlock =
  | { kind: "text" | "reasoning"; text: string }
  | { kind: "tool_call"; toolCallId: string; name: string; input: unknown }
  | { kind: "tool_result"; toolCallId: string; output: unknown; isError: boolean }
  | { kind: "other"; blockType: string; summary: string };

export type CompactTurn = {
  id: string;
  role: Turn["role"];
  origin: Turn["origin"];
  status: Turn["status"];
  finishReason: Turn["finishReason"];
  model: string | null;
  error: string | null;
  createdAt: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: string };
  blocks: CompactBlock[];
};

export type ThreadView = {
  thread: {
    id: string;
    ref: string | null;
    title: string | null;
    projectId: string;
    workId: string | null;
    agentName: string | null;
    status: Thread["status"];
    turnCount: number;
    totalCostUsd: string;
  };
  live: {
    status: string;
    runningTurnId: string | null;
    pending: number;
    actionRequired: boolean;
  };
  turns: CompactTurn[];
  showing: number;
  total: number;
};

const TEXT_LIMIT = 1_500;
const PAYLOAD_LIMIT = 400;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clip(value: unknown, limit: number, full: boolean): unknown {
  if (full) return value;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined || text.length <= limit) return value;
  return truncate(text, limit);
}

export function compactBlock(block: Block, limits: TranscriptLimits): CompactBlock {
  const content = record(block.content);
  switch (block.blockType) {
    case "text":
    case "reasoning":
    case "thinking": {
      const text = blockPlainText(block.blockType, block.content) ?? block.textContent ?? "";
      return {
        kind: block.blockType === "text" ? "text" : "reasoning",
        text: limits.full ? text : truncate(text, TEXT_LIMIT),
      };
    }
    case "tool_use":
      return {
        kind: "tool_call",
        toolCallId: String(content.toolCallId ?? ""),
        name: String(content.toolName ?? "tool"),
        input: clip(content.input, PAYLOAD_LIMIT, limits.full),
      };
    case "tool_result":
      return {
        kind: "tool_result",
        toolCallId: String(content.toolCallId ?? ""),
        output: clip(content.output, PAYLOAD_LIMIT, limits.full),
        isError: content.isError === true,
      };
    default:
      return {
        kind: "other",
        blockType: block.blockType,
        summary: truncate(
          oneLine(JSON.stringify(block.content) ?? ""),
          limits.full ? 100_000 : 160,
        ),
      };
  }
}

export function compactTurn(turn: Turn, limits: TranscriptLimits): CompactTurn {
  return {
    id: turn.id,
    role: turn.role,
    origin: turn.origin,
    status: turn.status,
    finishReason: turn.finishReason,
    model: turn.model ?? null,
    error: turn.error,
    createdAt: turn.createdAt,
    usage: {
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      costUsd: turn.totalCostUsd,
    },
    blocks: [...turn.blocks]
      .sort((a, b) => a.sequence - b.sequence)
      .map((block) => compactBlock(block, limits)),
  };
}

export function liveStatusLabel(snapshot: Pick<ThreadSnapshotResponse, "liveState">): string {
  const status = snapshot.liveState.status;
  return status.kind === "asleep" ? "asleep" : `awake:${status.phase}`;
}

export function projectThreadView(
  snapshot: ThreadSnapshotResponse,
  options: TranscriptLimits & { turnId?: string; last?: number },
): ThreadView {
  const allTurns = options.turnId
    ? snapshot.turns.filter(
        (turn) => turn.id === options.turnId || turn.id.startsWith(options.turnId ?? ""),
      )
    : snapshot.turns;
  const last = options.full || options.turnId ? allTurns.length : (options.last ?? 20);
  const turns = allTurns.slice(-last);
  const { thread } = snapshot;
  return {
    thread: {
      id: thread.id,
      ref: thread.ref,
      title: thread.title,
      projectId: thread.projectId,
      workId: thread.workId,
      agentName: thread.agentName,
      status: thread.status,
      turnCount: thread.turnCount,
      totalCostUsd: thread.totalCostUsd,
    },
    live: {
      status: liveStatusLabel(snapshot),
      runningTurnId: snapshot.liveState.runningTurnId,
      pending: snapshot.liveState.pending.items.length,
      actionRequired: snapshot.actionRequired,
    },
    turns: turns.map((turn) => compactTurn(turn, options)),
    showing: turns.length,
    total: allTurns.length,
  };
}

function renderBlock(block: CompactBlock): string {
  switch (block.kind) {
    case "text":
      return block.text.trim();
    case "reasoning":
      return `(reasoning) ${oneLine(block.text)}`;
    case "tool_call":
      return `tool_call ${block.name}(${oneLine(JSON.stringify(block.input) ?? "")}) [${block.toolCallId}]`;
    case "tool_result": {
      const output =
        typeof block.output === "string" ? block.output : (JSON.stringify(block.output) ?? "");
      return `tool_result [${block.toolCallId}]${block.isError ? " ERROR" : ""}: ${oneLine(output)}`;
    }
    case "other":
      return `(${block.blockType}) ${block.summary}`;
  }
}

export function renderThreadView(view: ThreadView): string {
  const { thread, live } = view;
  const lines = [
    `thread ${thread.id}${thread.ref ? ` (${thread.ref})` : ""}: ${thread.title ?? "(untitled)"}`,
    `  project ${thread.projectId}  work ${thread.workId ?? "(none)"}  agent ${thread.agentName ?? "?"}`,
    `  live ${live.status}${live.runningTurnId ? ` running ${live.runningTurnId}` : ""}  pending ${live.pending}${live.actionRequired ? "  ACTION REQUIRED" : ""}  cost $${thread.totalCostUsd}`,
    `  turns: showing ${view.showing} of ${view.total}${view.showing < view.total ? " (--full or --turn for more)" : ""}`,
  ];
  for (const turn of view.turns) {
    lines.push("");
    lines.push(
      `[${turn.role}] ${turn.id} ${turn.status}${turn.finishReason ? `/${turn.finishReason}` : ""}${turn.model ? ` ${turn.model}` : ""}${turn.role === "assistant" ? ` in=${turn.usage.inputTokens} out=${turn.usage.outputTokens}` : ""}`,
    );
    if (turn.error) lines.push(`  error: ${turn.error}`);
    for (const block of turn.blocks) {
      const rendered = renderBlock(block);
      if (rendered) lines.push(...rendered.split("\n").map((line) => `  ${line}`));
    }
  }
  return lines.join("\n");
}

export type ThreadListRow = {
  id: string;
  ref: string | null;
  title: string | null;
  projectId: string;
  workId: string | null;
  agentName: string | null;
  turnCount: number;
  updatedAt: string;
};

export function threadListRow(thread: Thread): ThreadListRow {
  return {
    id: thread.id,
    ref: thread.ref,
    title: thread.title,
    projectId: thread.projectId,
    workId: thread.workId,
    agentName: thread.agentName,
    turnCount: thread.turnCount,
    updatedAt: thread.updatedAt,
  };
}

export function renderThreadList(rows: ThreadListRow[]): string {
  if (rows.length === 0) return "(no threads)";
  return rows
    .map(
      (row) =>
        `${row.id}  ${row.ref ?? "-"}  ${row.updatedAt}  turns=${row.turnCount}  ${row.agentName ?? "?"}  ${row.title ?? "(untitled)"}`,
    )
    .join("\n");
}
