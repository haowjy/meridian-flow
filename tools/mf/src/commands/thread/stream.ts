/**
 * CLI presentation and follow predicates over the shared socket subscription.
 */
import type { ThreadLiveState } from "@meridian/contracts/protocol";
import type { ThreadTransport } from "@meridian/thread-client";
import type { Output } from "../../core/output";
import type { Session } from "../../core/session";
import { type CliEvent, RunEventMapper, renderEventLine } from "./events-map";
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
  /** Stop after the subscription catch-up instead of following live frames. */
  catchupOnly?: boolean;
  /** Replaces the default record and line per event; null drops the event from output. */
  present?: (event: CliEvent) => { value: Record<string, unknown>; line: string | null } | null;
  /** Request a stop after emission; confirmStop turns it into a state checkpoint. */
  shouldStop?: (event: CliEvent) => boolean;
  /** Idle lease/pending updates can arrive after the final turn event. */
  shouldStopState?: (state: ThreadLiveState) => boolean;
  /** Confirm a requested checkpoint without disposing subscription/presentation state. */
  confirmStop?: (turnIds: readonly string[]) => Promise<boolean>;
  transport?: ThreadTransport;
};

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

  const emit = (event: CliEvent): boolean => {
    if ("turnId" in event) turnIds.add(event.turnId);
    if (event.type === "event" && event.name === "meridian.thread.status") {
      const runningTurnId = (event.value as { runningTurnId?: unknown } | undefined)?.runningTurnId;
      if (typeof runningTurnId === "string") turnIds.add(runningTurnId);
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
      const message = await subscription.next(options.deadlineAt);
      switch (message.type) {
        case "live":
          state = message.state;
          if (state.runningTurnId) turnIds.add(state.runningTurnId);
          if (options.catchupOnly || options.shouldStopState?.(state)) stopRequested = true;
          break;
        case "event": {
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
          break;
        }
      }
      if (stopRequested) {
        if (options.confirmStop) {
          if (subscription.hasQueued()) continue;
          stopRequested = await options.confirmStop([...turnIds]);
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
