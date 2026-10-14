/**
 * The message folds: busy, the queued tray, the Stop and Cancel queue bodies, what a hand-back
 * hides. Pure selectors over the run-state view; they decide nothing
 * about which record is newer or when an intent retires (`run-state-view.ts` does).
 *
 * They read only `message` and `handBack` intents, and only items with `intent === "message"` and
 * writer provenance. A switch, or a control row, never counts toward busy, the tray or Stop.
 */

import type { HandBackScope, PendingInboxItem, StopRequest } from "@meridian/contracts/threads";
import type { RunStateView } from "./run-state-view";

const isWriterMessage = (item: PendingInboxItem) =>
  item.intent === "message" && item.provenance.kind === "writer";

/** The writer messages a record holds, in inbox order: the one rule for "a writer message", for every reader. */
export function writerMessages(record: { items: readonly PendingInboxItem[] }): PendingInboxItem[] {
  return record.items.filter(isWriterMessage);
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

/** The queued tray: writer messages waiting on the open reply, or all of them while a start is blocked. */
export function waitingWriterMessages(view: RunStateView): PendingInboxItem[] {
  const blocked = view.record?.blocked != null;
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

/** Cancel queue's scope: Stop's press set without the execution. */
export function cancelQueueScope(view: RunStateView): HandBackScope {
  return { kind: "seen", seenThrough: view.record?.sentThrough ?? 0, mine: messageIntentIds(view) };
}

/**
 * The messages a request hides while it is in flight, frozen at the press: the x's ids; for a
 * `seen` scope, the waiting writer messages at or below `seenThrough` plus `mine`. Delivered
 * history under the watermark and a message sent after the press are never in it.
 */
export function handBackCandidates(view: RunStateView, scope: HandBackScope): string[] {
  if (scope.kind === "ids") return [...scope.ids];
  const ids = waitingWriterMessages(view)
    .filter((item) => item.seq <= scope.seenThrough)
    .map((item) => item.id);
  return [...new Set([...ids, ...scope.mine])];
}

/** Where this tab's Stop control stands. Other tabs never see Stopping: they see the record. */
export type StopStatus = "idle" | "pending" | "stopping" | "failed";

/**
 * Stop's control state for the tab that pressed it. A request in flight or a failed one stands
 * as it is. Once answered, an answer that named a cancelled execution reads Stopping while the
 * held record still shows that execution; any other answer is already idle.
 */
export function stopStatus(
  view: RunStateView,
  command: { request: "idle" | "pending" | "failed"; cancelledExecutionId: string | null },
): StopStatus {
  if (command.request !== "idle") return command.request;
  const cancelled = command.cancelledExecutionId;
  return cancelled !== null && view.record?.execution?.executionId === cancelled
    ? "stopping"
    : "idle";
}
