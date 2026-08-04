// Versioned JSON result contract presented to editing models.
import type { ConcurrentEditInfo } from "../apply/types.js";
import { splitHashline } from "../model/hashline.js";
import type { TurnDiffResult } from "../ports/turn-diff-query.js";
import { type WriteCommandName, writeCommandName } from "./command-schema.js";

export const AGENT_EDIT_RESULT_SCHEMA = "meridian.agent-edit.v1" as const;

export type AgentEditResultCommand = WriteCommandName | "unknown";

export type WriteErrorStatus =
  | "not_found"
  | "ambiguous_match"
  | "invalid_write"
  | "document_not_found"
  | "partial_failure"
  | "cant_undo_dependent"
  | "internal_error";

export type UndoRedoOutcome =
  | "reversed"
  | "reconciled"
  | "partial"
  | "nothing_to_undo"
  | "nothing_to_redo"
  | "expired";

// Keep in sync with @meridian/contracts/protocol WriteStatus; agent-edit must stay host-agnostic.
export type WriteStatus = "success" | WriteErrorStatus | UndoRedoOutcome;
export type WriteSuccessPhase = "staged" | "committed";

export interface AgentEditBlockItem {
  hash: string;
  body: string;
}

export type AgentEditBlockGroup =
  | {
      extent: "full";
      relation: "document" | "changed" | "swept";
      items: AgentEditBlockItem[];
    }
  | {
      extent: "prefix";
      relation: "context";
      items: AgentEditBlockItem[];
    };

export interface AgentEditConcurrentRun {
  origin: "human" | "agent" | "mixed" | "concurrent edits";
  blocks: AgentEditBlockItem[];
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
  blocks?: AgentEditBlockGroup[];
  concurrent?: {
    runs: AgentEditConcurrentRun[];
    syncOverflow?: boolean;
  };
  diff?: TurnDiffResult | null;
  awarenessDegraded?: boolean;
}

interface AgentEditResultBase extends AgentEditModelPayload {
  schema: typeof AGENT_EDIT_RESULT_SCHEMA;
  command: AgentEditResultCommand;
}

export type AgentEditResultV1 = AgentEditResultBase &
  (
    | { status: "success"; phase: WriteSuccessPhase }
    | { status: Exclude<WriteStatus, "success">; phase?: never }
  );

type ModelResultInput = {
  command: AgentEditResultCommand;
  payload?: AgentEditModelPayload;
} & (
  | { status: "success"; phase: WriteSuccessPhase }
  | { status: Exclude<WriteStatus, "success">; phase?: never }
);

export function modelResult(input: ModelResultInput): AgentEditResultV1 {
  const base = {
    ...input.payload,
    schema: AGENT_EDIT_RESULT_SCHEMA,
    command: input.command,
  };
  if (input.status === "success") {
    return { ...base, status: "success", phase: input.phase };
  }
  return { ...base, status: input.status };
}

export function agentEditResultCommand(input: unknown): AgentEditResultCommand {
  return writeCommandName(input) ?? "unknown";
}

type AgentEditResultEnvelope = Record<string, unknown> & {
  schema: typeof AGENT_EDIT_RESULT_SCHEMA;
  command: AgentEditResultCommand;
  status: WriteStatus;
  phase?: WriteSuccessPhase;
};

/**
 * Validates only the durable envelope fields used by recovery.
 *
 * Payload fields remain opaque because recovery preserves them rather than
 * interpreting them. Naming this as an envelope check keeps the type guard
 * honest instead of claiming arbitrary persisted JSON is a full model result.
 */
export function isAgentEditResultEnvelope(input: unknown): input is AgentEditResultEnvelope {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const result = input as Record<string, unknown>;
  if (
    result.schema !== AGENT_EDIT_RESULT_SCHEMA ||
    (result.command !== "unknown" && writeCommandName(result) === undefined) ||
    !isWriteStatus(result.status)
  ) {
    return false;
  }
  if (result.status === "success") {
    return result.phase === "staged" || result.phase === "committed";
  }
  return result.phase === undefined;
}

function isWriteStatus(status: unknown): status is WriteStatus {
  switch (status) {
    case "success":
    case "not_found":
    case "ambiguous_match":
    case "invalid_write":
    case "document_not_found":
    case "partial_failure":
    case "cant_undo_dependent":
    case "internal_error":
    case "reversed":
    case "reconciled":
    case "partial":
    case "nothing_to_undo":
    case "nothing_to_redo":
    case "expired":
      return true;
    default:
      return false;
  }
}

export function modelBlockItem(serialized: string): AgentEditBlockItem {
  const line = splitHashline(serialized);
  if (!line) return { hash: "", body: serialized };
  return {
    hash: line.hash,
    body: line.body.startsWith("\n") ? line.body.slice(1) : line.body,
  };
}

export function modelConcurrentResult(
  info: ConcurrentEditInfo,
): NonNullable<AgentEditResultV1["concurrent"]> {
  return {
    runs: info.runs.map((run) => ({
      origin: run.origin,
      blocks: run.blocks.map(modelBlockItem),
      tombstones: run.tombstones.map(({ hash, capturedBody }) => ({
        hash,
        body: capturedBody,
      })),
    })),
    ...(info.syncOverflow ? { syncOverflow: true } : {}),
  };
}
