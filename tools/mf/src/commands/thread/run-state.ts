/**
 * `./mf`'s reads of a chat's run state, through the shared `@meridian/thread-client` module the
 * app uses. A snapshot, a subscribed state and a `meridian.run_state` frame all hold a whole
 * `RunState`; `./mf` has no intents of its own except the admission of a send, so these are thin
 * selectors over a view holding the newest record.
 */
import { RUN_STATE_EVENT, readRunState, type ThreadLiveState } from "@meridian/contracts/protocol";
import type { PendingInboxItem, RunState } from "@meridian/contracts/threads";
import {
  addIntent,
  INITIAL_RUN_STATE_VIEW,
  isBusy,
  isUsageBlocked,
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

/**
 * One send's own message in the chat's run state: the admission's `runStateVersion` as a message
 * intent (none when the admission has none: its record is from after it, so the record already
 * covers it), and every record `./mf` reads since. The message is owed while the record lists it,
 * or while no record at or past the admission has been read, which `./mf` cannot call settled.
 */
export class AdmittedMessage {
  private view: RunStateView = INITIAL_RUN_STATE_VIEW;

  constructor(
    private readonly userTurnId: string,
    runStateVersion: string | null,
  ) {
    if (runStateVersion !== null)
      this.view = addIntent(this.view, {
        kind: "message",
        id: userTurnId,
        answer: runStateVersion,
      });
  }

  /** Take a record from a snapshot, a subscribed state or a `meridian.run_state` frame. */
  take(runState: RunState): void {
    this.view = receiveRecord(this.view, runState);
  }

  /** The record lists this message, or no record has covered its admission yet. */
  owed(): boolean {
    return (
      (this.view.record?.items.some((item) => item.id === this.userTurnId) ?? false) ||
      this.view.intents.length > 0
    );
  }

  /** This message is waiting on usage: the record holds it and says the start is blocked. */
  blockedForUsage(): boolean {
    return (
      isUsageBlocked(this.view) &&
      (this.view.record?.items.some((item) => item.id === this.userTurnId) ?? false)
    );
  }
}
