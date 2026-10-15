/**
 * CLI presentation and follow predicates over the shared socket subscription.
 */
import {
  apiThreadSnapshotPath,
  type ThreadLiveState,
  type ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import type { ThreadTransport } from "@meridian/thread-client";
import type { Output } from "../../core/output";
import type { Session } from "../../core/session";
import { type CliEvent, RunEventMapper, renderEventLine } from "./events-map";
import type { ReducedThread } from "./reduced-thread";
import { currentTurnId, runStateOfEvent } from "./run-state";
import { createThreadClient, subscribeThread } from "./transport";

export type FollowResult = {
  lastSeq: string;
  turnIds: string[];
  truncated: boolean;
  stoppedBy: CliEvent | null;
  state: ThreadLiveState | null;
};

export type FollowOptions = {
  session: Session;
  threadId: string;
  /** Replay strictly after this seq. */
  lastSeq: string;
  deadlineAt: number;
  out: Output;
  full: boolean;
  /** Where text-mode event lines go (`send` keeps stdout for the final answer). */
  textStream: "out" | "err";
  /** Request a checkpoint when the stream reports a gap (its frames are missing, so the caller should look). */
  wakeOnGap?: boolean;
  /** Stop after the subscription catch-up instead of following live frames. */
  catchupOnly?: boolean;
  /** Replaces the default record and line per event; null drops the event from output. */
  present?: (event: CliEvent) => { value: Record<string, unknown>; line: string | null } | null;
  /** Request a stop after emission; confirmStop turns it into a state checkpoint. */
  shouldStop?: (event: CliEvent) => boolean;
  /** Idle lease/pending updates can arrive after the final turn event. */
  shouldStopState?: (state: ThreadLiveState) => boolean;
  /** Confirm a requested checkpoint without disposing subscription/presentation state. */
  confirmStop?: (turnIds: readonly string[], lastSeq: string) => Promise<boolean>;
  /** The deadline now in force, when it can move earlier than `deadlineAt` (a bounded catch-up after a settled claim). */
  currentDeadline?: () => number;
  transport?: ThreadTransport;
  /** Reduces every sequenced event into turn state, beside the log output. */
  reduced?: ReducedThread;
};

const ANCHOR_RETRY_MS = 250;

export async function followThread(options: FollowOptions): Promise<FollowResult> {
  const transport = options.transport ?? createThreadClient(options.session);
  const subscription = subscribeThread(transport, options.threadId, options.lastSeq);
  const mapper = new RunEventMapper();
  let lastSeq = options.lastSeq;
  const turnIds = new Set<string>();
  let requestedStop: CliEvent | null = null;
  let stopRequested = false;
  let truncated = false;
  let state: ThreadLiveState | null = null;
  let anchorAskedAt = 0;

  /**
   * A switch divider waits for a user turn the event stream never carries (a message this
   * follower did not hydrate, or another client's). Ask for a snapshot, bounded by the deadline,
   * at most once per interval; there is no tail-insertion fallback.
   */
  // One deadline for everything this follow does: stream reads, anchor recovery, snapshot reads.
  const effectiveDeadline = () =>
    Math.min(options.deadlineAt, options.currentDeadline?.() ?? options.deadlineAt);

  const recoverAnchor = async () => {
    const reduced = options.reduced;
    if (!reduced?.awaitsAnchor()) return;
    const remaining = effectiveDeadline() - Date.now();
    if (remaining <= 0 || Date.now() - anchorAskedAt < ANCHOR_RETRY_MS) return;
    anchorAskedAt = Date.now();
    const snapshot = await options.session.request<ThreadSnapshotResponse>(
      "GET",
      apiThreadSnapshotPath(options.threadId),
      undefined,
      { timeoutMs: remaining },
    );
    reduced.hydrate(snapshot, { observed: false });
  };

  const emit = (event: CliEvent): boolean => {
    if ("turnId" in event) turnIds.add(event.turnId);
    if (event.type === "event") {
      const turn = runStateOfEvent(event);
      if (turn?.execution?.currentTurnId) turnIds.add(turn.execution.currentTurnId);
    }
    const shown = options.present
      ? options.present(event)
      : { value: event, line: renderEventLine(event, options.full) };
    if (shown) {
      options.out.record(
        { ...shown.value, threadId: options.threadId },
        shown.line,
        options.textStream,
      );
    }
    return options.shouldStop?.(event) ?? false;
  };

  const consume = (seq: string, message: Parameters<RunEventMapper["map"]>[0]): CliEvent | null => {
    lastSeq = seq;
    for (const event of mapper.map(message)) {
      if (emit(event)) return event;
    }
    return null;
  };

  try {
    for (;;) {
      const message = await subscription.next(effectiveDeadline());
      switch (message.type) {
        case "live": {
          state = message.state;
          const turn = currentTurnId(state.runState);
          if (turn) turnIds.add(turn);
          if (options.catchupOnly || options.shouldStopState?.(state)) stopRequested = true;
          break;
        }
        case "event": {
          options.reduced?.apply(message.event.event, message.event.seq);
          await recoverAnchor();
          const stop = consume(message.event.seq, message.event);
          if (stop) {
            stopRequested = true;
            requestedStop = stop;
          }
          break;
        }
        case "gap": {
          truncated = true;
          const gap = message.gap;
          options.out.record(
            {
              type: "gap",
              threadId: options.threadId,
              cause: gap.cause,
              fromSeq: gap.fromSeq ?? null,
              toSeq: gap.toSeq ?? null,
            },
            `gap ${gap.cause} ${gap.fromSeq ?? "?"}..${gap.toSeq ?? "?"} (events skipped; ./mf thread view shows the durable state)`,
            options.textStream,
          );
          if (gap.toSeq && BigInt(gap.toSeq) > BigInt(lastSeq)) lastSeq = gap.toSeq;
          if (options.wakeOnGap) stopRequested = true;
          break;
        }
      }
      if (stopRequested) {
        if (options.confirmStop) {
          if (subscription.hasQueued()) continue;
          stopRequested = await options.confirmStop([...turnIds], lastSeq);
          // Frames queued during HTTP confirmation must be presented and their
          // named turns reconciled before the command may finish.
          if (subscription.hasQueued()) continue;
          if (!stopRequested) continue;
        }
        return { lastSeq, turnIds: [...turnIds], truncated, stoppedBy: requestedStop, state };
      }
    }
  } finally {
    subscription.unsubscribe();
    if (!options.transport) transport.disconnect();
  }
}
