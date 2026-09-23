/**
 * The port through which consumers request a new turn on a thread.
 * Defined here (not in orchestrator.ts) to break the import cycle between
 * the orchestrator and child-run-coordinator/turn-runner.
 */

import type { UserMessageBlock } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  ExecutionReportCorrelation,
  ReturnResultCapture,
  ReturnResultOutcome,
  TreeBudget,
} from "@meridian/contracts/spawn";
import type { JsonValue, OrchestratorEvent } from "@meridian/contracts/threads";
import type { Tool } from "../gateway/index.js";
import type { Lease } from "./ports.js";

export type ReturnResultCompleter = (capture: ReturnResultCapture) => Promise<ReturnResultOutcome>;

interface RunTurnBase {
  threadId: ThreadId;
  tools?: Tool[];
  signal?: AbortSignal;
  treeBudget?: TreeBudget;
  isSubagentThread?: boolean;
  returnResultCompleter?: ReturnResultCompleter;
  /** Parent invocation identity; omitted for writer and inbox continuations. */
  executionReport?: {
    correlation: ExecutionReportCorrelation;
    agentSlug?: string | null;
    description?: string | null;
  };
  /** The run's held lease; the loop releases it through closeRun when it exits. */
  lease?: Lease;
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

export function isDrainRun(input: RunTurnInput): input is DrainRunTurnInput {
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

export interface RunTurnHandle {
  userTurnId: TurnId;
  assistantTurnId: TurnId;
  events: AsyncGenerator<OrchestratorEvent>;
}

export interface FinalizeGeneratorFailureInput {
  threadId: ThreadId;
  assistantTurnId: TurnId;
  error: unknown;
  signal?: AbortSignal;
}

export interface RunTurnPort {
  runTurn(input: RunTurnInput): Promise<RunTurnHandle>;
  /** Persist + journal a terminal outcome when the event generator throws. */
  finalizeGeneratorFailure(input: FinalizeGeneratorFailureInput): Promise<void>;
}

export function createLateBindRunTurnPort(): RunTurnPort & { bind(target: RunTurnPort): void } {
  let target: RunTurnPort | null = null;
  return {
    runTurn(input) {
      if (!target) throw new Error("RunTurnPort not yet bound");
      return target.runTurn(input);
    },
    finalizeGeneratorFailure(input) {
      if (!target) throw new Error("RunTurnPort not yet bound");
      return target.finalizeGeneratorFailure(input);
    },
    bind(t: RunTurnPort) {
      target = t;
    },
  };
}
