/**
 * The port through which consumers request a new turn on a thread.
 * Defined here (not in orchestrator.ts) to break the import cycle between
 * the orchestrator and child-run-coordinator/turn-runner.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ReturnResultCapture, TreeBudget } from "@meridian/contracts/spawn";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import type { Tool } from "../gateway/index.js";

export type ReturnResultCompleter = (capture: ReturnResultCapture) => Promise<{ ok: true }>;

export interface RunTurnInput {
  threadId: ThreadId;
  userText: string;
  tools?: Tool[];
  signal?: AbortSignal;
  treeBudget?: TreeBudget;
  isSubagentThread?: boolean;
  returnResultCompleter?: ReturnResultCompleter;
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

export const noopFinalizeGeneratorFailure: RunTurnPort["finalizeGeneratorFailure"] = async () => {};

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
