/**
 * The port through which consumers request a new turn on a thread.
 * Preparation owns setup and returns a one-shot execution, not an event stream.
 */

import type { UserMessageBlock } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ExecutionReportCorrelation, TreeBudget } from "@meridian/contracts/spawn";
import type { JsonValue, Turn } from "@meridian/contracts/threads";
import type { Tool } from "../gateway/index.js";
import type { Lease } from "./ports.js";

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
  child?: { parentThreadId: ThreadId; background: boolean };
  onAssistantTurnChanged?: (turnId: TurnId) => void;
}

/** A run born from a new writer message: the setup mints the writer's user turn. */
export interface WriterRunTurnInput extends RunTurnBase {
  userText: string;
  userBlocks?: readonly UserMessageBlock[];
  activatedSkillSlugs?: readonly string[];
  /** Hidden metadata stamped on the user turn; never model-facing here. */
  userTurnMetadata?: JsonValue | null;
}

/**
 * A drain-only start (a wake): there is no new writer message. The first
 * drained message becomes the run's first user turn, ahead of the assistant
 * container, and the model sees exactly the drained batch.
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
 * assistant turn; a preceding `WorkContextDelivery.beforeTurn` may already have
 * persisted a `system_update` turn, which the next run reads as history. The
 * invariant is "no phantom assistant turn", not "no write".
 */
export class NoPendingWakeError extends Error {
  constructor(readonly threadId: ThreadId) {
    super("no_pending_wake");
    this.name = "NoPendingWakeError";
  }
}

export interface PreparedLoop {
  userTurnId: TurnId;
  assistantTurnId: TurnId;
  execute(): Promise<Turn>;
}

export type RunOutcome =
  | { status: "complete" | "cancelled" | "error"; turn: Turn }
  | { status: "failed"; error: unknown };

/** The recipient must execute every prepared run, even when already cancelled. */
export interface PreparedRun {
  runId: string;
  userTurnId: TurnId;
  assistantTurnId: TurnId;
  resumeAfterSeq: string;
  snapshotFloorNextSeq: string;
  execute(): Promise<RunOutcome>;
}

export interface RunTurnPort {
  prepare(input: RunTurnInput): Promise<PreparedRun>;
}
