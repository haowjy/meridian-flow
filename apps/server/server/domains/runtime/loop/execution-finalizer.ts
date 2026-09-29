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
import {
  CompactionFailureOutcomeCodec,
  CompactionFailureReasonCodec,
  compactionFailureMetadata,
  type EventJournalWriter,
  type ThreadRepositories,
} from "../../threads/index.js";
import { compactionFailureMeridianError } from "./compaction/decision.js";
import { persistAndAppendEvents } from "./persistence.js";

export type TerminalCause =
  | { kind: "success"; finishReason: FinishReason }
  | {
      kind: "failed";
      reason: string;
      error: MeridianError | string;
      /** Optional server-owned safe copy when a known failure has more useful writer guidance. */
      publicError?: string;
    }
  | { kind: "cancelled"; reason: string };

export type FinalizedExecution = {
  turn: Turn;
  events: OrchestratorEvent[];
  report: SavedExecutionReport | null;
};

function publicText(blocks: Block[], responseId: string | null): string {
  return blocks
    .filter((block) => block.responseId === responseId && block.blockType === "text")
    .map((block) => blockPlainText(block.blockType, block.content) ?? "")
    .join("");
}

async function resolveReportContent(
  input: {
    turnId: TurnId;
    responseId: string | null;
    capture: SavedExecutionReport["capture"];
    empty: boolean;
  },
  deps: Pick<ThreadRepositories, "blocks">,
) {
  if (input.empty) return { source: "empty" as const, summary: "", artifacts: null };

  const text = input.capture
    ? ""
    : publicText(await deps.blocks.listByTurn(input.turnId), input.responseId);
  return {
    source: input.capture
      ? ("return_result" as const)
      : text
        ? ("final_assistant" as const)
        : ("empty" as const),
    summary: input.capture?.summary ?? text,
    ...(input.capture?.payload === undefined ? {} : { payload: input.capture.payload }),
    artifacts: input.capture?.artifacts ?? null,
  };
}

function turnEvent(turn: Turn, cause: TerminalCause): OrchestratorEvent {
  if (cause.kind === "success") return { type: "turn.completed", turn };
  if (cause.kind === "cancelled") return { type: "turn.cancelled", turn };
  if (turn.role === "compaction") {
    return {
      type: "turn.error",
      turn,
      error: compactionFailureMeridianError(
        compactionFailureForFinalizer(cause),
        typeof cause.error === "string" ? cause.error : cause.error.message,
      ),
    };
  }
  const error =
    typeof cause.error === "string"
      ? meridianErrorFromSystem("runtime_error", cause.error)
      : cause.error;
  const existingDetails = error.details;
  return {
    type: "turn.error",
    turn,
    error: {
      ...error,
      details: {
        ...(existingDetails &&
        typeof existingDetails === "object" &&
        !Array.isArray(existingDetails)
          ? existingDetails
          : existingDetails === undefined
            ? {}
            : { errorDetails: existingDetails }),
        reason: cause.reason,
      },
    },
  };
}

function compactionFailureForFinalizer(cause: Extract<TerminalCause, { kind: "failed" }>) {
  if (cause.reason === "orphaned" || cause.reason === "shutdown")
    return { reason: "interrupted" as const, phase: "recovery" as const };
  if (typeof cause.error !== "string") {
    const details = CompactionFailureOutcomeCodec.safeParse(cause.error.details);
    if (details.success) return details.data;
  }
  const reason = CompactionFailureReasonCodec.safeParse(cause.reason);
  return {
    reason: reason.success ? reason.data : ("compaction_failed" as const),
    phase: "delivery" as const,
  };
}

/** Call under the thread lock; nested persistence joins its transaction. */
export async function finalizeExecution(
  deps: {
    repos: Pick<
      ThreadRepositories,
      | "promptBakes"
      | "threads"
      | "turns"
      | "blocks"
      | "imageInclusions"
      | "modelResponses"
      | "transaction"
      | "executionReports"
      | "runTurnStartTransition"
    >;
    eventWriter: EventJournalWriter;
    toolRegistry?: Pick<import("../tools/types.js").ToolRegistry, "getRegistration">;
  },
  input: {
    threadId: ThreadId;
    turnId: TurnId;
    /** A crash on a placeholder has no report content, even if a candidate was captured earlier. */
    reportContent?: "empty";
    cause: TerminalCause;
  },
): Promise<FinalizedExecution> {
  let report: SavedExecutionReport | null = null;
  const persisted = await persistAndAppendEvents(
    deps,
    input.threadId,
    async () => {
      const turn = await deps.repos.turns.findById(input.turnId);
      if (
        !turn ||
        turn.threadId !== input.threadId ||
        (turn.role !== "assistant" &&
          !(turn.role === "compaction" && input.cause.kind !== "success"))
      ) {
        throw new Error("Terminal turn is unavailable");
      }
      const ancestorReport = await deps.repos.executionReports.findByTurn(
        input.threadId,
        input.turnId,
      );
      const existingReport =
        turn.role === "compaction" && ancestorReport?.outcome !== null ? null : ancestorReport;
      const thread = await deps.repos.threads.lockByIdIncludingDeleted(input.threadId);
      if (thread?.kind === "subagent" && !existingReport && turn.role === "assistant") {
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
          ? (input.cause.publicError ??
            (typeof input.cause.error === "string" ? input.cause.error : input.cause.error.message))
          : null;
      const updated: Turn = {
        ...turn,
        ...(turn.role === "assistant" && input.cause.kind === "failed"
          ? {
              metadata: {
                ...(turn.metadata &&
                typeof turn.metadata === "object" &&
                !Array.isArray(turn.metadata)
                  ? turn.metadata
                  : {}),
                reason: input.cause.reason,
              },
            }
          : {}),
        ...(turn.role === "compaction" && input.cause.kind === "failed"
          ? {
              metadata: compactionFailureMetadata(
                turn.metadata,
                compactionFailureForFinalizer(input.cause),
              ),
            }
          : {}),
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
        const admitted = await deps.repos.executionReports.findByTurn(input.threadId, input.turnId);
        if (!admitted || (turn.role === "compaction" && admitted.outcome !== null)) return;
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
        const content = await resolveReportContent(
          {
            turnId: turn.id,
            responseId: finalResponseId,
            capture,
            empty: input.reportContent === "empty",
          },
          deps.repos,
        );
        let cost = responses.reduce((sum, row) => sum + BigInt(row.millicredits ?? "0"), 0n);
        let ancestor = turn;
        while (ancestor.id !== admitted.executionTurnId) {
          const parent = ancestor.parentTurnId
            ? await deps.repos.turns.findById(ancestor.parentTurnId)
            : null;
          if (!parent || parent.threadId !== input.threadId)
            throw new Error("Execution terminal is outside its admitted turn chain");
          ancestor = parent;
          if (ancestor.role === "assistant" || ancestor.role === "compaction") {
            const priorResponses = await deps.repos.modelResponses.listByTurn(ancestor.id);
            cost += priorResponses.reduce((sum, row) => sum + BigInt(row.millicredits ?? "0"), 0n);
          }
        }
        if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error("Execution cost exceeds report numeric range");
        }
        report = await deps.repos.executionReports.finalizeOnce({
          childThreadId: input.threadId,
          executionTurnId: admitted.executionTurnId,
          terminalTurnId: turn.id as TurnId,
          outcome,
          reason: input.cause.kind === "success" ? null : input.cause.reason,
          ...content,
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
