import type { AdmittedMessageBlock } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ExecutionReportCorrelation, TreeBudget } from "@meridian/contracts/spawn";
import type { BlockUpsertedRow, JsonValue, Turn } from "@meridian/contracts/threads";
import type { Tool } from "@meridian-flow/runtime/gateway";
import type { CurrentTurn, Lease, WakeRefusal } from "./ports.js";

interface RunTurnBase {
  threadId: ThreadId;
  tools?: Tool[];
  signal?: AbortSignal;
  treeBudget?: TreeBudget;
  executionReport?: {
    correlation: ExecutionReportCorrelation;
    agentSlug?: string | null;
    name?: string | null;
  };
  child?: {
    parentThreadId: ThreadId;
    parentExecutionId: string;
    background: boolean;
    origin: "spawn" | "message";
    sender: { ref: string | null; title: string | null };
  };
  onCurrentTurnChanged?: (turn: CurrentTurn) => void;
}

export interface WriterRunTurnInput extends RunTurnBase {
  userText: string;
  userBlocks?: readonly AdmittedMessageBlock[];
  seedBlocks?: BlockUpsertedRow[];
  activatedSkillSlugs?: readonly string[];
  userTurnMetadata?: JsonValue | null;
}

export interface DrainRunTurnInput extends RunTurnBase {
  drain: true;
  replyTurnId?: TurnId;
  retryOf?: TurnId;
}

export type RunTurnInput = WriterRunTurnInput | DrainRunTurnInput;
export type RunLoopInput = RunTurnInput & { lease: Lease };
export type DrainRunLoopInput = DrainRunTurnInput & { lease: Lease };

export function isDrainRun(input: RunLoopInput): input is DrainRunLoopInput {
  return "drain" in input && input.drain === true;
}

export class NoPendingWakeError extends Error {
  constructor(readonly threadId: ThreadId) {
    super("no_pending_wake");
    this.name = "NoPendingWakeError";
  }
}

export class WakeRefusedError extends Error {
  constructor(
    readonly refusal: WakeRefusal,
    readonly receiver: ThreadId | null,
  ) {
    super(`wake_refused:${refusal}`);
    this.name = "WakeRefusedError";
  }
}

export class RuntimeShuttingDownError extends Error {
  readonly code = "runtime_shutting_down";

  constructor(readonly threadId: ThreadId) {
    super("runtime_shutting_down");
    this.name = "RuntimeShuttingDownError";
  }
}

export class ReplyRetryUnavailableError extends Error {
  readonly code = "reply_retry_unavailable";

  constructor(readonly threadId: ThreadId) {
    super("reply_retry_unavailable");
    this.name = "ReplyRetryUnavailableError";
  }
}

export class ReplyRetryPendingError extends Error {
  readonly code = "retry_pending";

  constructor(readonly threadId: ThreadId) {
    super("retry_pending");
    this.name = "ReplyRetryPendingError";
  }
}

export class UnsettledPlaceholderError extends Error {
  constructor(cause: unknown) {
    super("Placeholder failure landing did not commit", { cause });
    this.name = "UnsettledPlaceholderError";
  }
}

export interface PreparedLoop {
  userTurnId: TurnId;
  currentTurn: CurrentTurn;
  execute(): Promise<Turn>;
}

export type RunOutcome =
  | { status: "complete" | "cancelled" | "error"; turn: Turn }
  | { status: "failed"; error: unknown };

export interface PreparedRun {
  executionId: string;
  userTurnId: TurnId;
  executionTurnId: TurnId;
  resumeAfterSeq: string;
  snapshotFloorNextSeq: string;
  execute(): Promise<RunOutcome>;
}

export interface RunTurnPort {
  prepare(input: RunTurnInput): Promise<PreparedRun>;
}
