/**
 * `./mf`'s observer over the shared `ThreadSync`: the Node ports (one HTTP read at a time, the
 * command's deadline, a plain value for the chat), printing frames, and what the claims read from
 * the sync (applied reads, the end-of-turn checks, gaps). The sync decides when to read, how a read
 * joins replay and in what order frames reach the turns; this file decides none of that.
 *
 * It keeps no queue of frames before the first read: the sync delivers none. Each frame is filtered
 * before printing and before claim bookkeeping: it counts only if its seq is above the claim's
 * cursor and above every seq already counted.
 */
import {
  apiThreadSnapshotPath,
  compareSeq,
  type ThreadLiveState,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";
import {
  createThreadSync,
  EMPTY_SYNCED_THREAD,
  SNAPSHOT_RETRY_MS,
  type SyncedThread,
  type SyncObservation,
  type ThreadSync,
} from "@meridian/thread-client/sync";
import { CliError } from "../../core/cli-error";
import type { Output } from "../../core/output";
import type { Session } from "../../core/session";
import { type CliEvent, RunEventMapper } from "./events-map";
import type { LiveReason, LiveViewReport } from "./live-view";
import { runStateOfEvent } from "./run-state";
import { recordEvent } from "./stream";
import { createThreadClient } from "./transport";

export type ObserverOptions = {
  session: Session;
  threadId: string;
  out: Output;
  full: boolean;
  /** Where text-mode event lines go (`send` keeps stdout for the final answer). */
  textStream: "out" | "err";
  /** Bounds every read from the start; `until` moves it. */
  deadlineAt: number;
  /** The chat's value before following: a send's admission has already raised its floor. */
  cell?: SyncedThread;
  /**
   * Frames at or below this seq are not the claim's. `send` passes the admission's `resumeAfterSeq`;
   * `tail` leaves it, and its first applied read's position is the cursor.
   */
  cursor?: string;
  /** A counted frame, after it printed. */
  onFrame?(event: CliEvent): void;
  /** A read the sync applied. */
  onRead?(read: ThreadSnapshotResponse): void;
  /** The `subscribed` state, after catch-up. */
  onLive?(state: ThreadLiveState): void;
  /** A gap, after it printed. */
  onGap?(): void;
};

export type Observer = {
  /** Ask for the first read. Frames reach the observer only after it applies. */
  start(): void;
  /** The claim wants a look: an unconditional, debounced read. */
  refresh(): void;
  /**
   * Resolve once `predicate` holds, checked after every observation. Rejects with a `timeout`
   * `CliError` at `deadlineAt`, or with the transport or read failure. `deadlineAt` also bounds
   * every read: at it no read starts, and the one in flight is abandoned by `close`.
   */
  until(predicate: () => boolean, deadlineAt: number): Promise<void>;
  /** Stop the sync, abort the read in flight and close the socket. */
  close(): void;
  /** Turns the stream named or the record showed running, as the frames and states arrived. */
  readonly turnIds: ReadonlySet<string>;
  /** A `turn.failed` was counted. */
  readonly failed: boolean;
  /** A gap that counts against the claim: it reaches past the cursor, or its range is unknown. */
  readonly truncated: boolean;
  /** The newest applied read. */
  readonly lastRead: ThreadSnapshotResponse | null;
  /** The stream has not yet reached the position `read` was taken at. */
  behind(read: ThreadSnapshotResponse): boolean;
  /** Claimed turns the stream ended but no applied read has checked yet. */
  pending(claimed: readonly string[], proving: ThreadSnapshotResponse): string[];
  /** `liveView` for the claimed assistant turns, from the checks. */
  liveView(claimed: readonly string[]): LiveViewReport;
};

export function createObserver(options: ObserverOptions): Observer {
  const { session, threadId, out } = options;
  const transport = createThreadClient(session);
  const mapper = new RunEventMapper();
  const abort = new AbortController();
  let cell = options.cell ?? EMPTY_SYNCED_THREAD;
  let sync: ThreadSync;

  const turnIds = new Set<string>();
  let failed = false;
  let truncated = false;
  let lastRead: ThreadSnapshotResponse | null = null;
  let cursor = options.cursor ?? null;
  let counted: string | null = null;
  /** Where the stream is: the join read's position, then the highest frame or gap seen. */
  let streamPos: string | null = null;
  const streamed = new Set<string>();
  const readEnded = new Set<string>();
  const checks = new Map<string, Extract<SyncObservation, { kind: "check" }>>();

  let closed = false;
  let deadline = options.deadlineAt;
  let failure: Error | null = null;
  let inflight = false;
  let queued = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const watchers = new Set<() => void>();
  const notify = () => {
    for (const watcher of [...watchers]) watcher();
  };
  const fail = (error: Error) => {
    failure ??= error;
    notify();
  };

  const above = (seq: string, floor: string | null) => floor === null || compareSeq(seq, floor) > 0;
  const raise = (seq: string | undefined) => {
    if (seq !== undefined && above(seq, streamPos)) streamPos = seq;
  };

  /** One read at a time. A read that starts after the deadline never starts. */
  async function readOnce(): Promise<void> {
    const remaining = deadline - Date.now();
    if (closed || remaining <= 0) return;
    inflight = true;
    try {
      const read = await session.request<ThreadSnapshotResponse>(
        "GET",
        apiThreadSnapshotPath(threadId),
        undefined,
        { timeoutMs: remaining, signal: abort.signal },
      );
      if (closed) return;
      if (sync.receive(read) === "stale") {
        retry = setTimeout(() => {
          retry = null;
          request("any");
        }, SNAPSHOT_RETRY_MS);
      }
    } catch (error) {
      if (!closed) fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      inflight = false;
      if (queued && !closed) {
        queued = false;
        void readOnce();
      }
    }
  }
  function request(kind: "fresh" | "any") {
    if (closed) return;
    if (inflight) {
      // "fresh" needs a read that starts after this call; "any" takes the one in flight.
      if (kind === "fresh") queued = true;
      return;
    }
    void readOnce();
  }

  const observe = (observation: SyncObservation) => {
    switch (observation.kind) {
      case "event": {
        const { seq } = observation.event;
        raise(seq);
        if (!above(seq, cursor) || !above(seq, counted)) break;
        counted = seq;
        for (const event of mapper.map(observation.event)) {
          if ("turnId" in event) turnIds.add(event.turnId);
          if (event.type === "event") {
            const record = runStateOfEvent(event);
            if (record?.execution?.currentTurnId) turnIds.add(record.execution.currentTurnId);
          }
          if (event.type === "turn.failed") failed = true;
          recordEvent(out, threadId, event, options.full, options.textStream);
          options.onFrame?.(event);
        }
        break;
      }
      case "live": {
        const turn = observation.state.runState.execution?.currentTurnId;
        if (turn) turnIds.add(turn);
        options.onLive?.(observation.state);
        break;
      }
      case "gap": {
        const { gap } = observation;
        raise(gap.toSeq);
        out.record(
          {
            type: "gap",
            threadId,
            cause: gap.cause,
            fromSeq: gap.fromSeq ?? null,
            toSeq: gap.toSeq ?? null,
          },
          `gap ${gap.cause} ${gap.fromSeq ?? "?"}..${gap.toSeq ?? "?"} (events skipped; ./mf thread view shows the durable state)`,
          options.textStream,
        );
        if (!gap.toSeq || cursor === null || compareSeq(gap.toSeq, cursor) > 0) truncated = true;
        options.onGap?.();
        break;
      }
      case "read": {
        if (!observation.applied) break;
        const { read } = observation;
        lastRead = read;
        if (cursor === null) cursor = read.liveState.resumeAfterSeq;
        // The first applied read joins the stream at its position, so that is where the stream is,
        // and the turn it shows running is one this run follows.
        if (streamPos === null) {
          streamPos = read.liveState.resumeAfterSeq;
          const running = read.liveState.runState.execution?.currentTurnId;
          if (running) turnIds.add(running);
        }
        for (const turn of read.turns)
          if (
            turn.role === "assistant" &&
            isTerminalTurnStatus(turn.status) &&
            !streamed.has(turn.id)
          )
            readEnded.add(turn.id);
        options.onRead?.(read);
        break;
      }
      case "turn":
        streamed.add(observation.turnId);
        break;
      case "check":
        checks.set(observation.turnId, observation);
        break;
      case "error":
        // Network errors belong to the shared reconnect policy, not the command outcome.
        if (observation.error instanceof CliError) failure ??= observation.error;
        break;
      case "interruptSettled":
        break;
    }
    notify();
  };

  sync = createThreadSync({
    threadId,
    transport,
    state: { get: () => cell, set: (next) => (cell = next) },
    requestSnapshot: request,
    observe,
    signal: abort.signal,
  });
  const unwatch = transport.onConnectionState((state) => {
    if (state.kind === "unauthorized" || state.kind === "terminal")
      fail(
        new CliError("unavailable", `Thread socket closed (${state.code ?? "?"} ${state.reason})`),
      );
  });

  return {
    start: () => sync.start(),
    refresh: () => sync.refresh(),

    until(predicate, deadlineAt) {
      deadline = deadlineAt;
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => settle(new CliError("timeout", "Timed out waiting for thread events")),
          Math.max(0, deadlineAt - Date.now()),
        );
        const settle = (error?: Error) => {
          clearTimeout(timer);
          watchers.delete(check);
          if (error) reject(error);
          else resolve();
        };
        const check = () => {
          if (failure) return settle(failure);
          if (predicate()) return settle();
          if (Date.now() >= deadlineAt)
            settle(new CliError("timeout", "Timed out waiting for thread events"));
        };
        watchers.add(check);
        check();
      });
    },

    close() {
      if (closed) return;
      sync.stop();
      closed = true;
      if (retry) clearTimeout(retry);
      abort.abort();
      unwatch();
      transport.disconnect();
    },

    get turnIds() {
      return turnIds;
    },
    get failed() {
      return failed;
    },
    get truncated() {
      return truncated;
    },
    get lastRead() {
      return lastRead;
    },

    behind: (read) =>
      streamPos === null || compareSeq(streamPos, read.liveState.resumeAfterSeq) < 0,

    pending: (claimed, proving) =>
      claimed.filter((id) => {
        const turn = proving.turns.find((candidate) => candidate.id === id);
        return turn && isTerminalTurnStatus(turn.status) && streamed.has(id) && !checks.has(id);
      }),

    liveView(claimed) {
      if (claimed.length === 0) return { liveView: "not_observed", liveReason: "no_turn" };
      const diffs = claimed.flatMap((id) => checks.get(id)?.diffs ?? []);
      if (diffs.length > 0) return { liveView: "differs", liveDiff: [...diffs] };
      const unchecked = claimed.find((id) => !checks.has(id));
      let reason: LiveReason | null = null;
      if (unchecked !== undefined) reason = readEnded.has(unchecked) ? "read_ended" : "not_ended";
      else if (claimed.some((id) => checks.get(id)?.rewritten)) reason = "rewritten";
      if (reason === null && truncated) reason = "gap";
      return reason ? { liveView: "not_observed", liveReason: reason } : { liveView: "matches" };
    },
  };
}
