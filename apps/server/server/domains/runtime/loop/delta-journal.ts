/**
 * Per-scope journal for high-volume live deltas. It writes immediately when
 * idle, batches only behind an in-flight write, and bounds admitted bytes so
 * database backpressure reaches the gateway consumer.
 */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { OrchestratorEvent } from "@meridian/contracts/threads";
import { type EventSink, emitEvent } from "../../observability/index.js";

export const MAX_UNJOURNALED_BYTES = 256 * 1024;
export const MAX_BATCH_EVENTS = 256;

type DeltaEvent = Extract<OrchestratorEvent, { type: "stream.delta" | "tool.output_delta" }>;

type DeltaAdmission =
  | { status: "accepted" }
  | { status: "sealed" }
  | { status: "full" }
  | { status: "failed"; cause: unknown };

const ACCEPTED = { status: "accepted" } as const;
const SEALED = { status: "sealed" } as const;
const FULL = { status: "full" } as const;

type DeltaJournalDeps = {
  threadId: ThreadId;
  appendEvents(threadId: ThreadId, events: readonly OrchestratorEvent[]): Promise<bigint>;
  eventSink: EventSink;
  scope: "model_request" | "tool_call";
};

function stringBytes(value: unknown): number {
  return typeof value === "string" ? value.length * 2 : 0;
}

function estimateDeltaEventBytes(event: DeltaEvent): number {
  return (
    64 +
    stringBytes("text" in event ? event.text : undefined) +
    stringBytes("argumentsDelta" in event ? event.argumentsDelta : undefined) +
    stringBytes("toolCallId" in event ? event.toolCallId : undefined) +
    stringBytes("toolName" in event ? event.toolName : undefined)
  );
}

function mergeDeltaEvents(previous: DeltaEvent, next: DeltaEvent): DeltaEvent | null {
  if (previous.type === "stream.delta" && next.type === "stream.delta") {
    if (previous.kind === "text" && next.kind === "text") {
      return { ...previous, text: (previous.text ?? "") + (next.text ?? "") };
    }
    if (previous.kind === "reasoning" && next.kind === "reasoning") {
      return { ...previous, text: (previous.text ?? "") + (next.text ?? "") };
    }
    if (
      previous.kind === "tool_call" &&
      next.kind === "tool_call" &&
      previous.toolCallId === next.toolCallId
    ) {
      return {
        ...previous,
        argumentsDelta: (previous.argumentsDelta ?? "") + (next.argumentsDelta ?? ""),
        toolName: previous.toolName || next.toolName,
      };
    }
    return null;
  }
  if (
    previous.type === "tool.output_delta" &&
    next.type === "tool.output_delta" &&
    previous.toolCallId === next.toolCallId &&
    previous.stream === next.stream
  ) {
    return { ...previous, text: previous.text + next.text };
  }
  return null;
}

export function createDeltaJournal(deps: DeltaJournalDeps) {
  const pending: DeltaEvent[] = [];
  let pendingBytes = 0;
  let inFlightBytes = 0;
  let writing = false;
  let sealed = false;
  let failure: { cause: unknown } | undefined;
  let writes = 0;
  let rows = 0;
  let mergedDeltas = 0;
  let peakUnjournaledBytes = 0;
  let fullSince: number | null = null;
  let timeSpentFullMs = 0;
  let flushToCommittedMs = 0;
  let summaryEmitted = false;
  const capacityWaiters = new Set<() => void>();
  const drainWaiters = new Set<() => void>();

  const unjournaledBytes = () => inFlightBytes + pendingBytes;

  function notify(waiters: Set<() => void>): void {
    for (const waiter of waiters) waiter();
    waiters.clear();
  }

  function leaveFull(): void {
    if (fullSince === null) return;
    timeSpentFullMs += performance.now() - fullSince;
    fullSince = null;
  }

  function fail(error: unknown): void {
    failure ??= { cause: error };
    leaveFull();
    notify(capacityWaiters);
    notify(drainWaiters);
  }

  function startWrite(): void {
    if (writing || failure !== undefined || pending.length === 0) return;
    const batch = pending.splice(0, MAX_BATCH_EVENTS);
    const batchBytes = batch.reduce((total, event) => total + estimateDeltaEventBytes(event), 0);
    pendingBytes -= batchBytes;
    inFlightBytes = batchBytes;
    writing = true;
    void deps
      .appendEvents(deps.threadId, batch)
      .then(() => {
        writes += 1;
        rows += batch.length;
        inFlightBytes = 0;
        writing = false;
        leaveFull();
        notify(capacityWaiters);
        if (pending.length > 0) startWrite();
        else notify(drainWaiters);
      })
      .catch(fail);
  }

  function prospectiveBytes(event: DeltaEvent): number {
    const last = pending.at(-1);
    if (!last) return unjournaledBytes() + estimateDeltaEventBytes(event);
    const merged = mergeDeltaEvents(last, event);
    if (!merged) return unjournaledBytes() + estimateDeltaEventBytes(event);
    return unjournaledBytes() - estimateDeltaEventBytes(last) + estimateDeltaEventBytes(merged);
  }

  function hasCapacity(event: DeltaEvent): boolean {
    return unjournaledBytes() === 0 || prospectiveBytes(event) <= MAX_UNJOURNALED_BYTES;
  }

  function admit(event: DeltaEvent): void {
    const last = pending.at(-1);
    const merged = last ? mergeDeltaEvents(last, event) : null;
    if (last && merged) {
      pending[pending.length - 1] = merged;
      pendingBytes += estimateDeltaEventBytes(merged) - estimateDeltaEventBytes(last);
      mergedDeltas += 1;
    } else {
      pending.push(event);
      pendingBytes += estimateDeltaEventBytes(event);
    }
    peakUnjournaledBytes = Math.max(peakUnjournaledBytes, unjournaledBytes());
    startWrite();
  }

  function waitFor(set: Set<() => void>): Promise<void> {
    return new Promise((resolve) => set.add(resolve));
  }

  async function push(event: DeltaEvent): Promise<void> {
    while (!hasCapacity(event)) {
      if (failure !== undefined) throw failure.cause;
      if (sealed) throw new Error("Delta journal is sealed");
      fullSince ??= performance.now();
      await waitFor(capacityWaiters);
    }
    if (failure !== undefined) throw failure.cause;
    if (sealed) throw new Error("Delta journal is sealed");
    admit(event);
  }

  function tryPush(event: DeltaEvent): DeltaAdmission {
    if (failure !== undefined) return { status: "failed", cause: failure.cause };
    if (sealed) return SEALED;
    if (!hasCapacity(event)) {
      fullSince ??= performance.now();
      return FULL;
    }
    admit(event);
    return ACCEPTED;
  }

  function seal(): void {
    if (sealed) return;
    sealed = true;
    notify(capacityWaiters);
  }

  function emitSummary(startedAt: number): void {
    flushToCommittedMs = Math.max(flushToCommittedMs, performance.now() - startedAt);
    if (!sealed || summaryEmitted) return;
    summaryEmitted = true;
    emitEvent(deps.eventSink, {
      level: "info",
      source: "runtime.delta-journal",
      name: "delta_journal.summary",
      correlation: { threadId: deps.threadId },
      payload: {
        scope: deps.scope,
        writes,
        rows,
        mergedDeltas,
        peakUnjournaledBytes,
        timeSpentFullMs,
        flushToCommittedMs,
        failed: failure !== undefined,
      },
    });
  }

  async function flush(): Promise<void> {
    const startedAt = performance.now();
    while (writing || pending.length > 0) {
      if (failure !== undefined) {
        emitSummary(startedAt);
        throw failure.cause;
      }
      await waitFor(drainWaiters);
    }
    emitSummary(startedAt);
    if (failure !== undefined) {
      throw failure.cause;
    }
  }

  return {
    push,
    tryPush,
    seal,
    flush,
  };
}
