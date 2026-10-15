/**
 * `./mf`'s reads of a chat's run state, through the shared `@meridian/thread-client` module the
 * app uses. A snapshot, a subscribed state and a `meridian.run_state` frame all hold a whole
 * `RunState`; `./mf` holds no intents (a send's message fate is `messageFate`'s), so these are thin
 * selectors over a view holding the newest record.
 */
import { RUN_STATE_EVENT, readRunState, type ThreadLiveState } from "@meridian/contracts/protocol";
import type { PendingInboxItem, RunState } from "@meridian/contracts/threads";
import {
  INITIAL_RUN_STATE_VIEW,
  isBusy,
  type RunStateView,
  receiveRecord,
  writerMessages,
} from "@meridian/thread-client";

/** The view over one live state's record. */
export const viewOfLive = (live: Pick<ThreadLiveState, "runState">): RunStateView =>
  receiveRecord(INITIAL_RUN_STATE_VIEW, live.runState);

/** The turn the open execution is on, or null. */
export const currentTurnId = (runState: RunState): string | null =>
  runState.execution?.currentTurnId ?? null;

/** No open execution and no writer message waiting: what `tail --until-idle` needs of the record. */
export const recordIsIdle = (live: Pick<ThreadLiveState, "runState">): boolean =>
  !isBusy(viewOfLive(live));

/** The writer messages the server still holds for this chat, in inbox order. */
export const owedWriterMessages = (runState: RunState): PendingInboxItem[] =>
  writerMessages(runState);

/** The run state a `meridian.run_state` frame carries, or null for any other event. */
export function runStateOfEvent(event: { name?: unknown; value?: unknown }): RunState | null {
  return event.name === RUN_STATE_EVENT ? readRunState(event.value) : null;
}
