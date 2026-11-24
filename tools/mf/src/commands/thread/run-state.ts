import { RUN_STATE_EVENT, readRunState, type ThreadLiveState } from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
import {
  INITIAL_RUN_STATE_VIEW,
  isBusy,
  type RunStateView,
  receiveRecord,
} from "@meridian/thread-client";

export const viewOfLive = (live: Pick<ThreadLiveState, "runState">): RunStateView =>
  receiveRecord(INITIAL_RUN_STATE_VIEW, live.runState);

export const recordIsIdle = (live: Pick<ThreadLiveState, "runState">): boolean =>
  !isBusy(viewOfLive(live));

export function runStateOfEvent(event: { name?: unknown; value?: unknown }): RunState | null {
  return event.name === RUN_STATE_EVENT ? readRunState(event.value) : null;
}
