/**
 * The message folds: busy, the queued tray, the Stop and Cancel queue bodies, what a hand-back
 * hides. Pure selectors over the run-state view; they decide nothing
 * about which record is newer or when an intent retires (`run-state-view.ts` does).
 *
 * They read only `message` and `handBack` intents, and only items with `intent === "message"` and
 * writer provenance. A switch, or a control row, never counts toward busy, the tray or Stop.
 */

import type { PendingInboxItem, SendNowRequest, StopRequest } from "@meridian/contracts/threads";
import type { RunStateView } from "./run-state-view";

const isWriterMessage = (item: PendingInboxItem) =>
  item.intent === "message" && item.provenance.kind === "writer";

/** The writer messages a record holds, in inbox order: the one rule for "a writer message", for every reader. */
export function writerMessages(record: { items: readonly PendingInboxItem[] }): PendingInboxItem[] {
  return record.items.filter(isWriterMessage);
}

/**
 * The record's writer messages whose turns the transcript does not hold. The stream carries a
 * record but not another client's user turn, so these are a gap only a snapshot fills.
 */
export function unheldWriterMessages(
  record: { items: readonly PendingInboxItem[] },
  holds: (userTurnId: string) => boolean,
): PendingInboxItem[] {
  return writerMessages(record).filter((item) => !holds(item.id));
}

/**
 * The messages an unretired, unfailed hand-back hides: left out of every fold below and, through
 * `viewTranscript`'s `hidden` input, out of the transcript. A failed one shows its rows again,
 * since the server may not have acted.
 */
export function hiddenWriterTurns(view: RunStateView): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const intent of view.intents)
    if (intent.kind === "handBack" && !intent.failed)
      for (const id of intent.candidates) hidden.add(id);
  return hidden;
}

/** The chat's writer messages the server still holds, less those a pending hand-back hides. */
function writerItems(view: RunStateView): PendingInboxItem[] {
  if (!view.record) return [];
  const hidden = hiddenWriterTurns(view);
  return writerMessages(view.record).filter((item) => !hidden.has(item.id));
}

const messageIntentIds = (view: RunStateView): string[] =>
  view.intents.flatMap((intent) => (intent.kind === "message" ? [intent.id] : []));

/**
 * Whether the chat is working or owes a reply: an open execution (until the record shows it
 * closed, whatever was handed back), a waiting writer message, or an admitted message the record
 * does not show yet. Before the first record only a message intent counts.
 */
export function isBusy(view: RunStateView): boolean {
  if (view.record?.execution) return true;
  if (writerItems(view).length > 0) return true;
  const hidden = hiddenWriterTurns(view);
  return view.intents.some((intent) => intent.kind === "message" && !hidden.has(intent.id));
}

/**
 * Whether the chat owes work with no open execution: a writer message waits (or was just
 * admitted) and nothing runs yet. The gap after a yield, or a start the usage balance blocks.
 */
export function isAwaitingExecution(view: RunStateView): boolean {
  return isBusy(view) && !view.record?.execution;
}

/** Whether the record says a start is blocked because the account is out of usage. */
export function isUsageBlocked(view: RunStateView): boolean {
  return view.record?.blocked?.reason === "credits_exhausted";
}

/**
 * Whether one writer message is still owed a reply: the record lists it, or it was admitted
 * (a message intent) and no record at or past its admission has been read to say otherwise.
 */
export function isOwed(view: RunStateView, userTurnId: string): boolean {
  return (
    (view.record?.items.some((item) => item.id === userTurnId) ?? false) ||
    view.intents.some((intent) => intent.kind === "message" && intent.id === userTurnId)
  );
}

/** The writer messages waiting on usage: the ones the record holds while it says a start is blocked. */
export function usageBlockedMessages(view: RunStateView): PendingInboxItem[] {
  return isUsageBlocked(view) ? writerItems(view) : [];
}

/** Whether this writer message waits on usage. */
export function isBlockedForUsage(view: RunStateView, userTurnId: string): boolean {
  return usageBlockedMessages(view).some((item) => item.id === userTurnId);
}

/**
 * The queued tray: writer messages waiting on the open reply, or all of them while delivery is
 * blocked. `deliveryBlocked` covers a durable ask, which intentionally leaves its messages in
 * `awaiting_run` rather than materializing turns before the continuation adopts them.
 */
export function waitingWriterMessages(
  view: RunStateView,
  deliveryBlocked = false,
): PendingInboxItem[] {
  const blocked = deliveryBlocked || view.record?.blocked != null;
  return writerItems(view).filter((item) => blocked || item.deliveryState === "waiting");
}

/** Stop's body, from the record the writer sees and this device's unanswered messages. */
export function stopRequest(view: RunStateView, requestId: string): StopRequest {
  return {
    requestId,
    seenThrough: view.record?.sentThrough ?? 0,
    seenExecutionId: view.record?.execution?.executionId ?? null,
    mine: messageIntentIds(view),
  };
}

/**
 * Send now's body: the open execution the writer saw and every writer message the record shows
 * waiting. Null when there is nothing to send now (no open reply, or nothing queued).
 */
export function sendNowRequest(view: RunStateView): SendNowRequest | null {
  const record = view.record;
  const executionId = record?.execution?.executionId;
  const waiting = waitingWriterMessages(view).map((item) => item.id);
  if (!record || !executionId || waiting.length === 0) return null;
  return { seenThrough: record.sentThrough, seenExecutionId: executionId, waiting };
}

/**
 * The messages Stop hides while its request is in flight, frozen at the press: the waiting writer
 * messages at or below `seenThrough` plus `mine`. Delivered history under the watermark and a
 * message sent after the press are never in it. (The queue's x and Cancel queue hide the ids
 * they were pressed over.)
 */
export function handBackCandidates(
  view: RunStateView,
  scope: { seenThrough: number; mine: readonly string[] },
): string[] {
  const ids = waitingWriterMessages(view)
    .filter((item) => item.seq <= scope.seenThrough)
    .map((item) => item.id);
  return [...new Set([...ids, ...scope.mine])];
}

/** Where this tab's Stop control stands. Other tabs never see Stopping: they see the record. */
export type StopStatus = "idle" | "pending" | "stopping" | "failed";

/** A Stop that failed: the execution it targeted and how many queued messages it was taking back. */
export type FailedStop = { targetExecutionId: string | null; candidates: number };

/**
 * A failed Stop that was taking back nothing owes the writer nothing once its reply ends: no
 * card, no failed Stop control. The one rule every reader of a failed Stop calls.
 */
export function failedStopIsMoot(view: RunStateView, stop: FailedStop): boolean {
  if (stop.candidates > 0) return false;
  const running = view.record?.execution?.executionId ?? null;
  return stop.targetExecutionId === null || running !== stop.targetExecutionId;
}

/**
 * Stop's control state for the tab that pressed it. A request in flight, or a failed Stop that is
 * not moot, stands as it is. Once answered, an answer that named a cancelled execution reads Stopping while the
 * held record still shows that execution; any other answer is already idle.
 */
export function stopStatus(
  view: RunStateView,
  command: {
    request: "idle" | "pending";
    cancelledExecutionId: string | null;
    /** Every Stop that failed; one that is not moot makes the control failed. */
    failedStops: readonly FailedStop[];
  },
): StopStatus {
  if (command.request === "pending") return "pending";
  if (command.failedStops.some((stop) => !failedStopIsMoot(view, stop))) return "failed";
  const cancelled = command.cancelledExecutionId;
  return cancelled !== null && view.record?.execution?.executionId === cancelled
    ? "stopping"
    : "idle";
}
