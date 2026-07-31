// Versioned JSON result contract presented to editing models.
import type { ConcurrentEditInfo } from "../apply/types.js";
import { splitHashline } from "../model/hashline.js";
import type { TurnDiffResult } from "../ports/turn-diff-query.js";
import type { WriteCommandName, WriteStatus, WriteSuccessPhase } from "./types.js";

export const AGENT_EDIT_RESULT_SCHEMA = "meridian.agent-edit.v1" as const;

export type AgentEditResultCommand = WriteCommandName | "unknown";

export type AgentEditBlockExtent = "full" | "prefix";
export type AgentEditBlockRelation =
  | "document"
  | "changed"
  | "context"
  | "concurrent"
  | "deleted"
  | "swept";

export interface AgentEditBlockRecord {
  hash: string;
  body: string;
  extent: AgentEditBlockExtent;
  relation: AgentEditBlockRelation;
}

export interface AgentEditConcurrentRun {
  origin: "human" | "agent" | "mixed" | "concurrent edits";
  blocks: AgentEditBlockRecord[];
  tombstones: Array<{ hash: string; body: string }>;
}

export interface AgentEditModelPayload {
  message?: string;
  write?: {
    id?: string;
    deletedHashes?: string[];
  };
  reversal?: {
    direction: "undo" | "redo";
    count: number;
  };
  read?: {
    format: "full" | "outline";
  };
  blocks?: AgentEditBlockRecord[];
  concurrent?: {
    runs: AgentEditConcurrentRun[];
    syncOverflow?: boolean;
  };
  diff?: TurnDiffResult | null;
  awarenessDegraded?: boolean;
}

export interface AgentEditResultV1 extends AgentEditModelPayload {
  schema: typeof AGENT_EDIT_RESULT_SCHEMA;
  command: AgentEditResultCommand;
  status: WriteStatus;
  phase?: WriteSuccessPhase;
}

export function modelResult(input: {
  command: AgentEditResultCommand;
  status: WriteStatus;
  phase?: WriteSuccessPhase;
  payload?: AgentEditModelPayload;
}): AgentEditResultV1 {
  return {
    schema: AGENT_EDIT_RESULT_SCHEMA,
    command: input.command,
    status: input.status,
    ...(input.phase ? { phase: input.phase } : {}),
    ...input.payload,
  };
}

export function agentEditResultCommand(input: unknown): AgentEditResultCommand {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "unknown";
  const command = (input as { command?: unknown }).command;
  switch (command) {
    case "read":
    case "diff":
    case "create":
    case "insert":
    case "replace":
    case "delete":
    case "undo":
    case "redo":
      return command;
    default:
      return "unknown";
  }
}

export function modelBlockRecord(
  serialized: string,
  extent: AgentEditBlockExtent,
  relation: AgentEditBlockRelation,
): AgentEditBlockRecord {
  const line = splitHashline(serialized);
  if (!line) return { hash: "", body: serialized, extent, relation };
  return {
    hash: line.hash,
    body: line.body.startsWith("\n") ? line.body.slice(1) : line.body,
    extent,
    relation,
  };
}

export function modelConcurrentResult(
  info: ConcurrentEditInfo,
): NonNullable<AgentEditResultV1["concurrent"]> {
  return {
    runs: info.runs.map((run) => ({
      origin: run.origin,
      blocks: run.blocks.map((block) => modelBlockRecord(block, "full", "concurrent")),
      tombstones: run.tombstones.map(({ hash, capturedBody }) => ({
        hash,
        body: capturedBody,
      })),
    })),
    ...(info.syncOverflow ? { syncOverflow: true } : {}),
  };
}
