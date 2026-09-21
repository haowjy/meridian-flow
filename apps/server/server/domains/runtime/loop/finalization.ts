/**
 * Turn finalization: builds terminal turn events (cancelled/error) and
 * appends them through the persistence seam.
 *
 * Both `finalizeCancelled` and `finalizeError` produce a turn lifecycle
 * event (turn.cancelled / turn.error) and set the turn's `completedAt`
 * timestamp. Thread run state is not written here: it is derived from the
 * live lease, so the thread reads `asleep` once the run releases it. The
 * next user turn clears the error banner via
 * `clearPreviousAssistantErrorIfUserTurn` in the read-model projector.
 *
 * These functions use `persistAndAppendEvents` so the turn status update
 * and journal append happen atomically with the read-model projection.
 */
import type { MeridianError } from "@meridian/contracts/interrupt";
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import {
  isTerminalTurnStatus,
  type OrchestratorEvent,
  type Turn,
} from "@meridian/contracts/threads";
import { toIsoString } from "../../threads/domain/contract-serialization.js";
import type { OrchestratorDeps } from "./orchestrator.js";
import { persistAndAppendEvents } from "./persistence.js";

export async function finalizeCancelled(
  deps: Pick<OrchestratorDeps, "repos" | "eventWriter">,
  threadId: ThreadId,
  turn: Turn,
): Promise<OrchestratorEvent[]> {
  const { events } = await persistAndAppendEvents(deps, threadId, async () => {
    const updatedTurn: Turn = {
      ...turn,
      status: "cancelled",
      completedAt: toIsoString(new Date()),
    };
    return { result: null, events: [{ type: "turn.cancelled", turn: updatedTurn }] };
  });
  return events;
}

export async function finalizeError(
  deps: Pick<OrchestratorDeps, "repos" | "eventWriter">,
  threadId: ThreadId,
  turn: Turn,
  error: MeridianError | string,
): Promise<OrchestratorEvent[]> {
  const meridianError =
    typeof error === "string" ? meridianErrorFromSystem("runtime_error", error) : error;
  const { events } = await persistAndAppendEvents(deps, threadId, async () => {
    const updatedTurn: Turn = {
      ...turn,
      status: "error",
      finishReason: "error",
      error: meridianError.message,
      completedAt: toIsoString(new Date()),
    };
    return {
      result: null,
      events: [{ type: "turn.error", turn: updatedTurn, error: meridianError }],
    };
  });
  return events;
}

/** Idempotent terminal finalize when a background generator exits without yielding. */
export async function finalizeTurnOnGeneratorFailure(
  deps: Pick<OrchestratorDeps, "repos" | "eventWriter">,
  input: {
    threadId: ThreadId;
    assistantTurnId: TurnId;
    error: unknown;
    signal?: AbortSignal;
  },
): Promise<OrchestratorEvent[]> {
  const turn = await deps.repos.turns.findById(input.assistantTurnId);
  if (!turn || turn.threadId !== input.threadId) return [];
  if (isTerminalTurnStatus(turn.status)) return [];
  if (input.signal?.aborted) {
    return finalizeCancelled(deps, input.threadId, turn);
  }
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  return finalizeError(deps, input.threadId, turn, message);
}
