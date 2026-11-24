import {
  type AGUIEvent,
  compareSeq,
  EventType,
  MESSAGES_HANDED_BACK_EVENT,
  parseSeq,
  RUN_STATE_EVENT,
  readRunState,
  readWriteModeSwitched,
  type SequencedEvent,
  type ThreadLiveState,
  type ThreadSnapshotResponse,
  TURNS_FORGOTTEN_EVENT,
  type Turn,
  type TurnStatus,
  WRITE_MODE_SWITCHED_EVENT,
} from "@meridian/contracts/protocol";
import { isTerminalTurnStatus, type RunState } from "@meridian/contracts/threads";
import type { ThreadGapEvent, ThreadTransport } from "../socket/thread-transport";
import {
  createTurnReducer,
  isDurableBlockEvent,
  isWellFormedDurableBlockEvent,
  type TurnStore,
} from "../turns/reduce-turn-event";
import { viewAssistantTurn } from "../view/assistant-view";
import { isOptimisticTurnId } from "../view/optimistic-turn-id";
import { type ScheduleFlush, StreamDeltaCoalescer } from "./stream-delta-coalescer";
import {
  acceptDurableBlockSeq,
  acceptsSnapshot,
  applyRead,
  missing,
  raiseDeliveryCursor,
  receiveRunState,
  type SyncedThread,
  syncedTurnStore,
} from "./synced-thread";

export const REFRESH_DEBOUNCE_MS = 250;
export const SNAPSHOT_RETRY_MS = 250;

export type Diff = {
  turnId: string;
  field: "status" | "finalText";
  live: string | null;
  server: string | null;
};

export type SyncObservation =
  | { kind: "event"; event: SequencedEvent }
  | { kind: "live"; state: ThreadLiveState }
  | { kind: "gap"; gap: ThreadGapEvent }
  | { kind: "read"; read: ThreadSnapshotResponse; applied: boolean; cached: boolean }
  | { kind: "check"; turnId: string; rewritten: boolean; diffs: readonly Diff[] }
  | { kind: "turn"; turnId: string; status: TurnStatus }
  | { kind: "error"; error: Error };

export type ThreadSyncPorts = {
  threadId: string;
  transport: ThreadTransport;
  state: { get(): SyncedThread; set(next: SyncedThread): void };
  requestSnapshot(kind: "fresh" | "any"): void;
  observe(observation: SyncObservation): void;
  signal: AbortSignal;
  now?: () => string;
  scheduleFlush?: ScheduleFlush;
};

export type ThreadSync = {
  start(held?: ThreadSnapshotResponse): boolean;
  stop(): void;
  receive(read: ThreadSnapshotResponse): "applied" | "stale";
  refresh(): void;
};

function ownText(turn: Pick<Turn, "blocks" | "status">): string {
  return viewAssistantTurn(turn)
    .items.map((item) => (item.kind === "text" ? item.text : ""))
    .join("");
}

export function createThreadSync(ports: ThreadSyncPorts): ThreadSync {
  const { threadId, transport, state, requestSnapshot, observe, signal } = ports;
  const now = ports.now ?? (() => new Date().toISOString());

  const written = new Set<string>();
  const endedOnce = new Set<string>();
  const unchecked = new Set<string>();
  const rewritten = new Set<string>();

  let started = false;
  let generation = 0;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unconditional = false;
  let seen: { version: string; executionId: string | null } | null = null;

  const current = (expected: number) => started && !signal.aborted && generation === expected;

  const base = syncedTurnStore({
    cell: { get: () => state.get(), set: (_id, next) => state.set(next) },
    now,
    onTurnEnsured: (_id, turnId) => observe({ kind: "turn", turnId, status: "streaming" }),
    onStatusPatched(_id, turnId, status, before) {
      if (before.role === "user" && isOptimisticTurnId(turnId)) return;
      if (
        before.role === "assistant" &&
        !isTerminalTurnStatus(before.status) &&
        isTerminalTurnStatus(status) &&
        !endedOnce.has(turnId)
      ) {
        endedOnce.add(turnId);
        unchecked.add(turnId);
      }
      observe({ kind: "turn", turnId, status });
      if (!isTerminalTurnStatus(status)) return;
      requestSnapshot("fresh");
    },
    invalidateThreadSnapshot: () => requestSnapshot("any"),
  });
  const turnOf = (turnId: string) => state.get().turns.find((turn) => turn.id === turnId);
  const tracked = (turnId: string, write: () => void) => {
    const before = turnOf(turnId);
    write();
    if (turnOf(turnId) !== before) written.add(turnId);
  };
  const store: TurnStore = {
    ...base,
    ensureAssistantTurn: (id, turnId, opts) =>
      tracked(turnId, () => base.ensureAssistantTurn(id, turnId, opts)),
    upsertAssistantBlock: (id, turnId, block) =>
      tracked(turnId, () => base.upsertAssistantBlock(id, turnId, block)),
    patchTurnStatus: (id, turnId, status, patch) =>
      tracked(turnId, () => base.patchTurnStatus(id, turnId, status, patch)),
  };
  const reducer = createTurnReducer({ now, store });

  const coalescer = new StreamDeltaCoalescer((event, seq) => {
    if (!started || signal.aborted) return;
    reducer.applyEvent(threadId, event);
    delivered(seq);
  }, ports.scheduleFlush);
  function delivered(seq: string | undefined) {
    if (seq === undefined) return;
    const next = raiseDeliveryCursor(state.get(), seq);
    if (next !== state.get()) state.set(next);
  }
  const flush = () => {
    if (!signal.aborted) coalescer.flush();
  };

  const dispatchRunState = (action: Parameters<typeof receiveRunState>[1]) =>
    state.set(receiveRunState(state.get(), action));

  const schedule = (expected: number, onlyIfGap = false) => {
    if (!current(expected)) return;
    if (!onlyIfGap) unconditional = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const run = unconditional || missing(state.get());
      unconditional = false;
      if (current(expected) && run) requestSnapshot("fresh");
    }, REFRESH_DEBOUNCE_MS);
  };

  const noteRecord = (runState: RunState): boolean => {
    const newer = seen === null || compareSeq(runState.version, seen.version) > 0;
    const executionId = runState.execution?.executionId ?? null;
    const changed = newer && seen !== null && seen.executionId !== executionId;
    if (newer) seen = { version: runState.version, executionId };
    return changed;
  };

  const subscribe = (expected: number, after: string): (() => void) =>
    transport.subscribe(
      threadId,
      {
        onEvent: (sequenced) => {
          const { event, error, seq, sourceThreadId } = sequenced;
          if (!current(expected) || (sourceThreadId && sourceThreadId !== threadId)) return;
          if ("threadId" in event && event.threadId !== threadId) return;
          observe({ kind: "event", event: sequenced });
          if (
            event.type === EventType.RUN_STARTED ||
            event.type === EventType.RUN_FINISHED ||
            event.type === EventType.RUN_ERROR
          )
            schedule(expected);
          if (event.type === EventType.CUSTOM && event.name === "meridian.usage")
            schedule(expected);
          if (event.type === EventType.CUSTOM && event.name === RUN_STATE_EVENT) {
            const runState = readRunState(event.value);
            if (runState && parseSeq(seq) !== null) {
              dispatchRunState({ type: "record", runState });
              delivered(seq);
              if (noteRecord(runState)) schedule(expected);
              else schedule(expected, true);
            }
            return;
          }
          if (event.type === EventType.CUSTOM && event.name === WRITE_MODE_SWITCHED_EVENT) {
            const switched = readWriteModeSwitched(event.value);
            if (switched && parseSeq(seq) !== null) {
              flush();
              reducer.applyEvent(threadId, event, seq);
              dispatchRunState({ type: "switched", seq, ...switched });
              delivered(seq);
              if (missing(state.get())) schedule(expected, true);
            }
            return;
          }
          if (event.type === EventType.CUSTOM && event.name === MESSAGES_HANDED_BACK_EVENT) {
            flush();
            if (parseSeq(seq) !== null) {
              reducer.applyEvent(threadId, event, seq);
              delivered(seq);
            }
            return;
          }
          if (event.type === EventType.CUSTOM && event.name === TURNS_FORGOTTEN_EVENT) {
            flush();
            reducer.applyEvent(threadId, event, seq);
            delivered(seq);
            return;
          }
          if (event.type === EventType.CUSTOM && event.name === "meridian.thread.status")
            schedule(expected);
          if (isDurableBlockEvent(event)) {
            if (!isWellFormedDurableBlockEvent(event) || parseSeq(seq) === null) return;
            flush();
            if (!current(expected)) return;
            const next = acceptDurableBlockSeq(state.get(), seq);
            if (!next) return;
            state.set(next);
            reducer.applyDurableBlockEvent(threadId, event);
            delivered(seq);
            return;
          }
          const effective: AGUIEvent =
            event.type === EventType.RUN_ERROR && error
              ? { ...event, message: error.message }
              : event;
          if ("runId" in effective && typeof effective.runId === "string")
            store.ensureAssistantTurn(threadId, effective.runId);
          coalescer.push(effective, seq);
        },
        onLiveState: (live) => {
          if (!current(expected)) return;
          dispatchRunState({ type: "snapshot", runState: live.runState });
          noteRecord(live.runState);
          observe({ kind: "live", state: live });
          schedule(expected, true);
        },
        onUnavailable: (unavailable) => {
          if (current(expected)) state.set({ ...state.get(), unavailable });
        },
        onError: (failure) => {
          if (!current(expected)) return;
          flush();
          observe({ kind: "error", error: failure });
        },
        onGap: (gap) => {
          if (!current(expected)) return;
          flush();
          observe({ kind: "gap", gap });
          delivered(gap.toSeq);
          schedule(expected);
        },
      },
      { after },
    );

  const markHeldTurnsRewritten = () => {
    for (const turn of state.get().turns) {
      if (turn.role !== "assistant" || endedOnce.has(turn.id) || written.has(turn.id)) continue;
      if (rewritten.has(turn.id)) continue;
      if (isTerminalTurnStatus(turn.status) || ownText(turn) !== "") rewritten.add(turn.id);
    }
  };

  const checkRead = (read: ThreadSnapshotResponse): SyncObservation[] => {
    const held = new Map(state.get().turns.map((turn) => [turn.id, turn]));
    const incoming = new Map(read.turns.map((turn) => [turn.id, turn]));
    const checks: SyncObservation[] = [];
    for (const turnId of [...unchecked]) {
      const server = incoming.get(turnId);
      const live = held.get(turnId);
      if (!server || !live) continue;
      unchecked.delete(turnId);
      const diffs: Diff[] = [];
      if (live.status !== server.status)
        diffs.push({ turnId, field: "status", live: live.status, server: server.status });
      const liveText = ownText(live);
      const serverText = ownText(server);
      if (liveText !== serverText)
        diffs.push({ turnId, field: "finalText", live: liveText, server: serverText });
      checks.push({ kind: "check", turnId, rewritten: rewritten.has(turnId), diffs });
    }
    for (const server of read.turns) {
      if (server.role !== "assistant" || endedOnce.has(server.id) || rewritten.has(server.id))
        continue;
      if (isTerminalTurnStatus(server.status)) {
        rewritten.add(server.id);
        continue;
      }
      const live = held.get(server.id);
      if (!written.has(server.id)) {
        if (ownText(server) !== "") rewritten.add(server.id);
      } else if (live && (live.status !== server.status || ownText(live) !== ownText(server))) {
        rewritten.add(server.id);
      }
    }
    return checks;
  };

  const accept = (read: ThreadSnapshotResponse, cached: boolean): "applied" | "stale" => {
    if (signal.aborted) return "stale";
    flush();
    // keep: A joining read must be newer than every frame the held value reflects or stream-built turns are dropped
    const joining = started && unsubscribe === null;
    const held = state.get().deliveryCursor;
    if (
      !acceptsSnapshot(state.get(), read.nextSeq) ||
      (joining && held !== null && compareSeq(read.nextSeq, held) <= 0)
    ) {
      observe({ kind: "read", read, applied: false, cached });
      return "stale";
    }
    // keep: Run end-of-turn checks against the cell as the stream left it before the read lands
    const checks = checkRead(read);
    const runState = read.liveState.runState;
    const next = applyRead(state.get(), {
      turns: read.turns,
      asks: read.asks,
      nextSeq: read.nextSeq,
      runningTurnId: runState.execution?.currentTurnId ?? null,
      runState,
    });
    if (!next) return "stale";
    state.set(next);
    for (const check of checks) observe(check);
    observe({ kind: "read", read, applied: true, cached });
    noteRecord(runState);
    if (joining) {
      const resume = read.liveState.resumeAfterSeq;
      const expected = generation;
      const after = held !== null && compareSeq(held, resume) > 0 ? held : resume;
      const acquired = subscribe(expected, after);
      if (current(expected)) unsubscribe = acquired;
      else acquired();
    }
    return "applied";
  };

  return {
    start(held) {
      if (started || signal.aborted) return false;
      started = true;
      markHeldTurnsRewritten();
      if (held && accept(held, true) === "applied") return true;
      requestSnapshot("any");
      return false;
    },

    stop() {
      flush();
      started = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
      unconditional = false;
      unsubscribe?.();
      unsubscribe = null;
    },

    receive: (read) => accept(read, false),

    refresh() {
      schedule(generation);
    },
  };
}
