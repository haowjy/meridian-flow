/** One terminal transaction for a turn and its admitted child execution report. */
import type { MeridianError } from "@meridian/contracts/interrupt";
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import {
  type Block,
  blockPlainText,
  type FinishReason,
  isTerminalTurnStatus,
  type OrchestratorEvent,
  type Turn,
} from "@meridian/contracts/threads";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import type { EventJournalWriter, ThreadRepositories } from "../../threads/index.js";
import { persistAndAppendEvents } from "./persistence.js";

export type TerminalCause =
  | { kind: "success"; finishReason: FinishReason }
  | { kind: "failed"; reason: string; error: MeridianError | string }
  | { kind: "cancelled"; reason: string };

export type FinalizedExecution = {
  turn: Turn;
  events: OrchestratorEvent[];
  report: SavedExecutionReport | null;
};

function publicText(blocks: Block[], responseId: string | null): string {
  return blocks
    .filter(
      (block) => block.responseId === responseId && block.blockType === "text" && !block.pruned,
    )
    .map((block) => blockPlainText(block.blockType, block.content) ?? "")
    .join("");
}

function turnEvent(turn: Turn, cause: TerminalCause): OrchestratorEvent {
  if (cause.kind === "success") return { type: "turn.completed", turn };
  if (cause.kind === "cancelled") return { type: "turn.cancelled", turn };
  const error =
    typeof cause.error === "string"
      ? meridianErrorFromSystem("runtime_error", cause.error)
      : cause.error;
  return { type: "turn.error", turn, error };
}

/** Call under the child final-drain lock; nested persistence joins its transaction. */
export async function finalizeExecution(
  deps: {
    repos: Pick<
      ThreadRepositories,
      | "threads"
      | "turns"
      | "blocks"
      | "modelResponses"
      | "transaction"
      | "executionReports"
      | "runTurnStartTransition"
    >;
    eventWriter: EventJournalWriter;
  },
  input: { threadId: ThreadId; assistantTurnId: TurnId; cause: TerminalCause },
): Promise<FinalizedExecution> {
  let report: SavedExecutionReport | null = null;
  const persisted = await persistAndAppendEvents(
    deps,
    input.threadId,
    async () => {
      const turn = await deps.repos.turns.findById(input.assistantTurnId);
      if (!turn || turn.threadId !== input.threadId || turn.role !== "assistant") {
        throw new Error("Terminal assistant turn is unavailable");
      }
      const existingReport = await deps.repos.executionReports.findByTurn(
        input.threadId,
        input.assistantTurnId,
      );
      const thread = await deps.repos.threads.lockByIdIncludingDeleted(input.threadId);
      if (thread?.kind === "subagent" && !existingReport) {
        throw new Error("Subagent execution was not admitted");
      }
      if (isTerminalTurnStatus(turn.status)) {
        if (existingReport && existingReport.outcome === null)
          throw new Error("Terminal child turn is missing its report outcome");
        report = existingReport;
        return { result: turn, events: [] };
      }
      const completedAt = toIsoString(new Date());
      const error =
        input.cause.kind === "failed"
          ? typeof input.cause.error === "string"
            ? input.cause.error
            : input.cause.error.message
          : null;
      const updated: Turn = {
        ...turn,
        status:
          input.cause.kind === "success"
            ? "complete"
            : input.cause.kind === "cancelled"
              ? "cancelled"
              : "error",
        finishReason:
          input.cause.kind === "success"
            ? input.cause.finishReason
            : input.cause.kind === "failed"
              ? "error"
              : turn.finishReason,
        error,
        completedAt,
      };
      if (input.cause.kind === "success") {
        await deps.repos.threads.updateCost(input.threadId, "0", 1);
      }
      return { result: updated, events: [turnEvent(updated, input.cause)] };
    },
    {
      async afterEvents(turn) {
        const admitted = await deps.repos.executionReports.findByTurn(
          input.threadId,
          input.assistantTurnId,
        );
        if (!admitted) return;
        if (admitted.outcome !== null) {
          report = admitted;
          return;
        }
        const capture = admitted.capture;
        const outcome =
          input.cause.kind === "success"
            ? "succeeded"
            : input.cause.kind === "cancelled"
              ? "cancelled"
              : "failed";
        const responses = await deps.repos.modelResponses.listByTurn(turn.id);
        const finalResponseId = responses.at(-1)?.id ?? null;
        const text = capture
          ? ""
          : publicText(await deps.repos.blocks.listByTurn(turn.id), finalResponseId);
        const source = capture ? "return_result" : text ? "final_assistant" : "empty";
        let cost = responses.reduce((sum, row) => sum + BigInt(row.millicredits ?? "0"), 0n);
        let ancestor = turn;
        while (ancestor.id !== admitted.assistantTurnId) {
          const parent = ancestor.parentTurnId
            ? await deps.repos.turns.findById(ancestor.parentTurnId)
            : null;
          if (!parent || parent.threadId !== input.threadId)
            throw new Error("Execution terminal is outside its admitted turn chain");
          ancestor = parent;
          if (ancestor.role === "assistant") {
            const priorResponses = await deps.repos.modelResponses.listByTurn(ancestor.id);
            cost += priorResponses.reduce((sum, row) => sum + BigInt(row.millicredits ?? "0"), 0n);
          }
        }
        if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("Execution cost exceeds report numeric range");
        }
        report = await deps.repos.executionReports.finalizeOnce({
          childThreadId: input.threadId,
          assistantTurnId: admitted.assistantTurnId,
          terminalAssistantTurnId: turn.id as TurnId,
          outcome,
          reason: input.cause.kind === "success" ? null : input.cause.reason,
          source,
          summary: capture?.summary ?? text,
          ...(capture && capture.payload !== undefined ? { payload: capture.payload } : {}),
          artifacts: capture?.artifacts ?? null,
          costMillicredits: Number(cost),
        });
        if (admitted.origin === "spawn") {
          await deps.repos.threads.updateSpawnLifecycle(input.threadId, { spawnStatus: outcome });
        }
      },
    },
  );
  return { turn: persisted.result, events: persisted.events, report };
}
