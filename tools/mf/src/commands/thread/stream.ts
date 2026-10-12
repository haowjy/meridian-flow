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
  /** Return true to stop following after this event has been emitted. */
  shouldStop?: (event: CliEvent) => boolean;
  transport?: ThreadTransport;
};

export async function followThread(options: FollowOptions): Promise<FollowResult> {
  const transport = options.transport ?? createThreadClient(options.session);
  const subscription = subscribeThread(transport, options.threadId, options.lastSeq);
  const mapper = new RunEventMapper();
  let lastSeq = options.lastSeq;
  let state: ThreadLiveState | null = null;

  const emit = (event: CliEvent): boolean => {
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
          if (options.catchupOnly) return { lastSeq, stoppedBy: null, state };
          break;
        case "event": {
          const stop = consume(message.event.seq, message.event);
          if (stop) return { lastSeq, stoppedBy: stop, state };
          break;
        }
        case "gap": {
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
    }
  } finally {
    subscription.unsubscribe();
    if (!options.transport) transport.disconnect();
  }
}
