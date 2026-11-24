import type {
  PendingInboxItem,
  SendNowRequest,
  StopRequest,
  ThreadAsk,
} from "@meridian/contracts/threads";
import type { RunStateView } from "./run-state-view";

const isWriterMessage = (item: PendingInboxItem) =>
  item.intent === "message" && item.provenance.kind === "writer";

export function writerMessages(record: { items: readonly PendingInboxItem[] }): PendingInboxItem[] {
  return record.items.filter(isWriterMessage);
}

export function unheldWriterMessages(
  record: { items: readonly PendingInboxItem[] },
  holds: (userTurnId: string) => boolean,
): PendingInboxItem[] {
  return writerMessages(record).filter((item) => !holds(item.id));
}

export function hiddenWriterTurns(view: RunStateView): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const intent of view.intents)
    if (intent.kind === "handBack" && !intent.failed)
      for (const id of intent.candidates) hidden.add(id);
  return hidden;
}

function writerItems(view: RunStateView): PendingInboxItem[] {
  if (!view.record) return [];
  const hidden = hiddenWriterTurns(view);
  return writerMessages(view.record).filter((item) => !hidden.has(item.id));
}

const messageIntentIds = (view: RunStateView): string[] =>
  view.intents.flatMap((intent) => (intent.kind === "message" ? [intent.id] : []));

export function isBusy(view: RunStateView): boolean {
  if (view.record?.execution) return true;
  if (writerItems(view).length > 0) return true;
  const hidden = hiddenWriterTurns(view);
  return view.intents.some((intent) => intent.kind === "message" && !hidden.has(intent.id));
}

export function isAwaitingExecution(view: RunStateView): boolean {
  return isBusy(view) && !view.record?.execution;
}

export function isUsageBlocked(view: RunStateView): boolean {
  return view.record?.blocked?.reason === "credits_exhausted";
}

export function isOwed(view: RunStateView, userTurnId: string): boolean {
  return (
    (view.record?.items.some((item) => item.id === userTurnId) ?? false) ||
    view.intents.some((intent) => intent.kind === "message" && intent.id === userTurnId)
  );
}

export function usageBlockedMessages(view: RunStateView): PendingInboxItem[] {
  return isUsageBlocked(view) ? writerItems(view) : [];
}

export function isBlockedForUsage(view: RunStateView, userTurnId: string): boolean {
  return usageBlockedMessages(view).some((item) => item.id === userTurnId);
}

const deliveryWaitingWriterMessages = (view: RunStateView): PendingInboxItem[] => {
  const blocked = view.record?.blocked != null;
  return writerItems(view).filter((item) => blocked || item.deliveryState === "waiting");
};

export function waitingWriterMessages(
  view: RunStateView,
  asks: Iterable<Pick<ThreadAsk, "status">>,
): PendingInboxItem[] {
  for (const ask of asks) if (ask.status === "open") return writerItems(view);
  return deliveryWaitingWriterMessages(view);
}

export function stopRequest(view: RunStateView, requestId: string): StopRequest {
  return {
    requestId,
    seenThrough: view.record?.sentThrough ?? 0,
    seenExecutionId: view.record?.execution?.executionId ?? null,
    mine: messageIntentIds(view),
  };
}

export function sendNowRequest(
  view: RunStateView,
  asks: Iterable<Pick<ThreadAsk, "status">>,
): SendNowRequest | null {
  const record = view.record;
  const executionId = record?.execution?.executionId;
  const waiting = waitingWriterMessages(view, asks).map((item) => item.id);
  if (!record || !executionId || waiting.length === 0) return null;
  return { seenThrough: record.sentThrough, seenExecutionId: executionId, waiting };
}

export function handBackCandidates(
  view: RunStateView,
  scope: { seenThrough: number; mine: readonly string[] },
): string[] {
  const ids = deliveryWaitingWriterMessages(view)
    .filter((item) => item.seq <= scope.seenThrough)
    .map((item) => item.id);
  return [...new Set([...ids, ...scope.mine])];
}

export type StopStatus = "idle" | "pending" | "stopping" | "failed";

export type FailedStop = { targetExecutionId: string | null; candidates: number };

export function failedStopIsMoot(view: RunStateView, stop: FailedStop): boolean {
  if (stop.candidates > 0) return false;
  const running = view.record?.execution?.executionId ?? null;
  return stop.targetExecutionId === null || running !== stop.targetExecutionId;
}

export function stopStatus(
  view: RunStateView,
  command: {
    request: "idle" | "pending";
    cancelledExecutionId: string | null;
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
