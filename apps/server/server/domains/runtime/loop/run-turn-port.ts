/**
 * The port through which consumers request a new turn on a thread.
 * Preparation owns setup and returns a one-shot execution, not an event stream.
 */

import type { UserMessageBlock } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ExecutionReportCorrelation, TreeBudget } from "@meridian/contracts/spawn";
import type { BlockUpsertedRow, JsonValue, Turn } from "@meridian/contracts/threads";
import type { Tool } from "../gateway/index.js";
import type { CurrentTurn, Lease } from "./ports.js";

interface RunTurnBase {
  threadId: ThreadId;
  tools?: Tool[];
  signal?: AbortSignal;
  treeBudget?: TreeBudget;
  /** Parent invocation identity; omitted for writer and inbox continuations. */
  executionReport?: {
    correlation: ExecutionReportCorrelation;
    agentSlug?: string | null;
    description?: string | null;
  };
  child?: { parentThreadId: ThreadId; background: boolean; origin: "spawn" | "message" };
  onCurrentTurnChanged?: (turn: CurrentTurn) => void;
}

/** A run born from a direct writer message: setup persists the user turn before preparation. */
export interface WriterRunTurnInput extends RunTurnBase {
  userText: string;
  userBlocks?: readonly UserMessageBlock[];
  /** Runtime-only context appended after user blocks; persistence assigns turn and sequence. */
  seedBlocks?: BlockUpsertedRow[];
  activatedSkillSlugs?: readonly string[];
  /** Hidden metadata stamped on the user turn; never model-facing here. */
  userTurnMetadata?: JsonValue | null;
}

/**
 * A drain-only start (a wake): there is no new writer message. The first
 * drained message becomes the run's first user turn, ahead of the first reserved
 * turn, and the model sees exactly the drained batch.
 */
export interface DrainRunTurnInput extends RunTurnBase {
  drain: true;
}

export type RunTurnInput = WriterRunTurnInput | DrainRunTurnInput;
/** Session-owned state passed only to setup and the model loop. */
export type RunLoopInput = RunTurnInput & { lease: Lease };
export type DrainRunLoopInput = DrainRunTurnInput & { lease: Lease };

export function isDrainRun(input: RunLoopInput): input is DrainRunLoopInput {
  return "drain" in input && input.drain === true;
}

/**
 * The drain start found no durable pending message to serve. The drain mints no
 * assistant turn; idle Work materialization may already have persisted a
 * `system_update` turn, which the next run reads as history. The
 * invariant is "no phantom assistant turn", not "no write".
 */
export class NoPendingWakeError extends Error {
  constructor(readonly threadId: ThreadId) {
    super("no_pending_wake");
    this.name = "NoPendingWakeError";
  }
}

/** The app is closing; refuse work that has not yet acquired a run session. */
export class RuntimeShuttingDownError extends Error {
  constructor(readonly threadId: ThreadId) {
    super("runtime_shutting_down");
    this.name = "RuntimeShuttingDownError";
  }
}

/** A live placeholder's failure transaction did not commit. Orphan repair owns
 * its terminal state; paid response rows still in memory are lost like a crash,
 * not separately debited outside the transaction that ends the placeholder.
 */
export class UnsettledPlaceholderError extends Error {
  constructor(cause: unknown) {
    super("Placeholder failure landing did not commit", { cause });
    this.name = "UnsettledPlaceholderError";
  }
}

export interface PreparedLoop {
  userTurnId: TurnId;
  currentTurn: CurrentTurn | null;
  terminalTurnId?: TurnId;
  execute(): Promise<Turn>;
}

export type RunOutcome =
  | { status: "complete" | "cancelled" | "error"; turn: Turn }
  | { status: "failed"; error: unknown };

/** The recipient must execute every prepared run, even when already cancelled. */
export interface PreparedRun {
  runId: string;
  userTurnId: TurnId;
  executionTurnId: TurnId;
  resumeAfterSeq: string;
  snapshotFloorNextSeq: string;
  execute(): Promise<RunOutcome>;
}

export interface RunTurnPort {
  prepare(input: RunTurnInput): Promise<PreparedRun>;
}
