/**
 * `createThreadSync`: the one framework-free object that keeps a chat's client state in step with
 * the server, for the app and for `./mf`. It owns the chat's transcript handler on the transport,
 * the rules for when to ask for a read, what counts as missing, how a read applies and joins
 * replay, the order frames reach the turns, and the end-of-turn checks.
 *
 * It holds no state a screen reads: the chat's `SyncedThread` lives in the host's `state` port,
 * changed only by the package's pure transitions. It never fetches: it asks the host for a read
 * (`requestSnapshot`), and every completed read comes back through `receive`. Effects, printing
 * and claims are the host's, told through `observe` after the write they follow.
 */
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
import { isBusy } from "../run-state/fold-messages";
import { INITIAL_RUN_STATE_VIEW, receiveRecord } from "../run-state/run-state-view";
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
  receiveRunState,
  type SyncedThread,
  syncedTurnStore,
} from "./synced-thread";

/** The refresh timer's debounce: requests inside one window share a read. */
export const REFRESH_DEBOUNCE_MS = 250;
/** How long a host waits before asking again after `receive` said `stale`. */
export const SNAPSHOT_RETRY_MS = 250;

/** One way a stream-ended turn differed from the read that checked it. */
export type Diff = {
  turnId: string;
  field: "status" | "finalText";
  /** What the sync's turns showed when the stream ended the turn. */
  live: string | null;
  /** What the read stored. */
  server: string | null;
};

export type SyncObservation =
  /** Every frame as received, with its seq and error. */
  | { kind: "event"; event: SequencedEvent }
  /** The `subscribed` state, after catch-up. */
  | { kind: "live"; state: ThreadLiveState }
  | { kind: "gap"; gap: ThreadGapEvent }
  | { kind: "read"; read: ThreadSnapshotResponse; applied: boolean }
  | { kind: "check"; turnId: string; rewritten: boolean; diffs: readonly Diff[] }
  /** A stream write that started a turn or changed its status. */
  | { kind: "turn"; turnId: string; status: TurnStatus }
  | {
      kind: "interruptSettled";
      identity: { threadId: string; turnId: string; interruptId: string };
    }
  | { kind: "error"; error: Error };

export type ThreadSyncPorts = {
  threadId: string;
  transport: ThreadTransport;
  state: { get(): SyncedThread; set(next: SyncedThread): void };
  /**
   * Start a read; the result comes back through `receive`.
   * "fresh": deliver a read that starts after this call (cancel the one in flight, or follow it with another).
   * "any": a read already in flight will do.
   */
  requestSnapshot(kind: "fresh" | "any"): void;
  /** The host's effects, printing and checks. Called after the write each follows. */
  observe(observation: SyncObservation): void;
  /** The account epoch; `./mf` passes its command's. */
  signal: AbortSignal;
  /** ISO time for reducer-created rows. */
  now?: () => string;
  /** Default `frameScheduler`. */
  scheduleFlush?: ScheduleFlush;
};

export type ThreadSync = {
  /** Begin a generation: add the transcript handler. Idempotent. */
  start(): void;
  /** End it: flush, cancel timers, remove the handler. */
  stop(): void;
  /** Take a completed read. Works started or not; joins replay only when started. */
  receive(read: ThreadSnapshotResponse): "applied" | "stale";
  /** An unconditional, debounced "fresh" read. */
  refresh(): void;
};

/** The turn's own text: the text items of its view, joined in order. It reads the turn alone. */
function ownText(turn: Pick<Turn, "blocks">): string {
  return viewAssistantTurn(turn)
    .items.map((item) => (item.kind === "text" ? item.text : ""))
    .join("");
}

/** Whether a record shows the chat working or owing a reply: a read of it is worth joining the stream for. */
function worksIn(runState: RunState): boolean {
  return isBusy(receiveRecord(INITIAL_RUN_STATE_VIEW, runState));
}

export function createThreadSync(ports: ThreadSyncPorts): ThreadSync {
  const { threadId, transport, state, requestSnapshot, observe, signal } = ports;
  const now = ports.now ?? (() => new Date().toISOString());

  // The end-of-turn check's facts: sets of turn ids, for the life of the sync.
  /** Turns this sync's reducer has changed. */
  const written = new Set<string>();
  /** Turns whose first not-terminal to terminal move the stream made. */
  const endedOnce = new Set<string>();
  /** Stream-ended turns still waiting for the next applied read. */
  const unchecked = new Set<string>();
  /** Turns a read put in the cell before the stream ended them. Never cleared. */
  const rewritten = new Set<string>();

  let started = false;
  let generation = 0;
  let unsubscribe: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** A pending refresh that must run whatever the transcript holds. */
  let unconditional = false;
  /** The newest record seen, to tell a frame whose execution changed. */
  let seen: { version: string; executionId: string | null } | null = null;
  /** Whether the first applied read has been taken: only it may rewind the stream. */
  let joined = false;

  const current = (expected: number) => started && !signal.aborted && generation === expected;

  // The reducer writes through the host's cell. Each operation reads the current value and writes
  // the next before returning; observations go out after the write.
  const base = syncedTurnStore({
    cell: { get: () => state.get(), set: (_id, next) => state.set(next) },
    now,
    onTurnEnsured: (_id, turnId) => observe({ kind: "turn", turnId, status: "streaming" }),
    onStatusPatched(_id, turnId, status, before) {
      // An unadmitted writer row carries local knowledge, never a server lifecycle event.
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
      reducer.clearPendingInterruptPatchesForTurn(threadId, turnId);
      requestSnapshot("fresh");
    },
    invalidateThreadSnapshot: () => requestSnapshot("any"),
    settleInterruptResponse: (identity) => observe({ kind: "interruptSettled", identity }),
  });
  const turnOf = (turnId: string) => state.get().turns.find((turn) => turn.id === turnId);
  /** Run a write to one turn and remember that the reducer changed it. */
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

  // One frame boundary for the stream: append-only deltas coalesce into a single write, and
  // everything else flushes first.
  const coalescer = new StreamDeltaCoalescer((event) => {
    if (started && !signal.aborted) reducer.applyEvent(threadId, event);
  }, ports.scheduleFlush);
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

  const subscribe = (expected: number, after?: string): (() => void) =>
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
              // A cancelled compaction ends with no RUN_FINISHED, and a divider reserves or
              // settles with the execution: a record whose execution changed revalidates.
              if (noteRecord(runState)) schedule(expected);
              // Another client's waiting message: its turn is not on the stream.
              else schedule(expected, true);
            }
            return;
          }
          if (event.type === EventType.CUSTOM && event.name === WRITE_MODE_SWITCHED_EVENT) {
            const switched = readWriteModeSwitched(event.value);
            if (switched && parseSeq(seq) !== null) {
              // The divider turn is the transcript's, whatever the record says; the same
              // frame answers the writer's control in the run-state slice.
              flush();
              reducer.applyEvent(threadId, event, seq);
              dispatchRunState({ type: "switched", seq, ...switched });
              // The turn it follows is not in the transcript: the gap check asks for a read.
              if (missing(state.get())) schedule(expected, true);
            }
            return;
          }
          // Waiting messages that left the chat leave this transcript at the frame's seq.
          if (event.type === EventType.CUSTOM && event.name === MESSAGES_HANDED_BACK_EVENT) {
            flush();
            if (parseSeq(seq) !== null) reducer.applyEvent(threadId, event, seq);
            return;
          }
          // Failed turns the chat left behind are stamped wherever they are held.
          if (event.type === EventType.CUSTOM && event.name === TURNS_FORGOTTEN_EVENT) {
            flush();
            reducer.applyEvent(threadId, event, seq);
            return;
          }
          // A handoff brief holds the chat with no lease or run, so its start and end reach
          // the chat only as a status frame.
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
            return;
          }
          // The stream: every other event belongs to the turn it names, or to the one
          // streaming, which the reducer resolves for events that name none.
          const effective: AGUIEvent =
            event.type === EventType.RUN_ERROR && error
              ? { ...event, message: error.message }
              : event;
          if ("runId" in effective && typeof effective.runId === "string")
            store.ensureAssistantTurn(threadId, effective.runId);
          coalescer.push(effective);
        },
        // The `subscribed` state is a whole record, read after catch-up.
        onLiveState: (live) => {
          if (!current(expected)) return;
          dispatchRunState({ type: "snapshot", runState: live.runState });
          noteRecord(live.runState);
          observe({ kind: "live", state: live });
          schedule(expected, true);
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
          schedule(expected);
        },
      },
      after === undefined ? undefined : { after },
    );

  /** Turns the cell already holds with text of their own, or ended: this sync's reducer wrote none of it. */
  const markHeldTurnsRewritten = () => {
    for (const turn of state.get().turns) {
      if (turn.role !== "assistant" || endedOnce.has(turn.id) || written.has(turn.id)) continue;
      if (rewritten.has(turn.id)) continue;
      if (isTerminalTurnStatus(turn.status) || ownText(turn) !== "") rewritten.add(turn.id);
    }
  };

  /**
   * Before a read applies: check each stream-ended turn against the read's, then mark the turns
   * the read writes ahead of the stream. Returns the checks to announce once the read is written.
   */
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

  return {
    start() {
      if (started || signal.aborted) return;
      started = true;
      const expected = generation;
      let acquired: (() => void) | null = null;
      try {
        markHeldTurnsRewritten();
        acquired = subscribe(expected);
        if (!current(expected)) {
          acquired();
          return;
        }
        unsubscribe = acquired;
      } catch (error) {
        acquired?.();
        started = false;
        throw error;
      }
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

    receive(read) {
      if (signal.aborted) return "stale";
      // Fix 1: a delta buffered before this read belongs before it, not appended to its text.
      flush();
      if (!acceptsSnapshot(state.get(), read.nextSeq)) {
        observe({ kind: "read", read, applied: false });
        return "stale";
      }
      // The checks compare the cell as the stream left it, so they run before the read lands.
      const checks = checkRead(read);
      const runState = read.liveState.runState;
      const next = applyRead(state.get(), {
        turns: read.turns,
        nextSeq: read.nextSeq,
        runningTurnId: runState.execution?.currentTurnId ?? null,
        runState,
      });
      if (!next) return "stale";
      state.set(next);
      reducer.clearPendingInterruptPatchesForThread(threadId);
      for (const check of checks) observe(check);
      observe({ kind: "read", read, applied: true });
      noteRecord(runState);
      // The first applied read, if it shows work in progress, joins the stream from its cursor:
      // this subscription began at start, so the reply it comes to has deltas between the
      // read and the subscription that only replay brings. A later read never rewinds.
      if (started && !joined) {
        joined = true;
        if (worksIn(runState) && !signal.aborted && unsubscribe) {
          unsubscribe();
          unsubscribe = subscribe(generation, read.liveState.resumeAfterSeq);
        }
      }
      return "applied";
    },

    refresh() {
      schedule(generation);
    },
  };
}
