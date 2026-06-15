/**
 * Turn finalization: builds terminal turn events (cancelled/error) and
 * appends them through the persistence seam.
 *
 * Both `finalizeCancelled` and `finalizeError` produce a turn lifecycle
 * event (turn.cancelled / turn.error), set the turn's `completedAt`
 * timestamp, and transition the thread status:
 * - cancelled → thread status "idle" (the user can retry)
 * - error → thread status "error" (the thread is blocked until the user
 *   sends a new message, which clears the error banner via
 *   `clearPreviousAssistantErrorIfUserTurn` in the read-model projector)
 *
 * These functions use `persistAndAppendEvents` so the turn status update
 * and journal append happen atomically with the read-model projection.
 * Thread status update (`repos.threads.updateStatus`) is executed inside
 * the transaction as a direct repository call — it is not yet projected
 * from an event.
 */
import type { MeridianError } from "@meridian/contracts/interrupt";
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent, Turn } from "@meridian/contracts/threads";
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
    // Thread returns to idle so the user can immediately send another
    // message — cancellation is not an error state.
    await deps.repos.threads.updateStatus(threadId, "idle");
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
    // Thread enters error state; the next user turn.created event will
    // trigger clearPreviousAssistantErrorIfUserTurn in the read-model
    // projector to clear the error banner without erasing the journal fact.
    await deps.repos.threads.updateStatus(threadId, "error");
    return {
      result: null,
      events: [{ type: "turn.error", turn: updatedTurn, error: meridianError }],
    };
  });
  return events;
}
