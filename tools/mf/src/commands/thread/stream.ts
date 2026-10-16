/**
 * The journal printer: a deadline-bounded subscription that prints each frame as `./mf` words it.
 * `thread events` and plain `thread tail` use it and claim nothing from the stream's content.
 * `send` and `tail --until-idle` follow through `ThreadSync` instead (`observe.ts`).
 */
import type { Output } from "../../core/output";
import type { Session } from "../../core/session";
import { type CliEvent, RunEventMapper, renderEventLine } from "./events-map";
import { createThreadClient, subscribeThread } from "./transport";

export type FollowResult = {
  lastSeq: string;
  /** A replay gap: frames are missing, so nothing here proves completeness. */
  truncated: boolean;
};

export type FollowOptions = {
  session: Session;
  threadId: string;
  /** Replay strictly after this seq. */
  lastSeq: string;
  deadlineAt: number;
  out: Output;
  full: boolean;
  /** Where text-mode event lines go. */
  textStream: "out" | "err";
  /** Stop after the subscription catch-up instead of following live frames. */
  catchupOnly?: boolean;
  /** Replaces the default record and line per event; null drops the event from output. */
  present?: (event: CliEvent) => { value: Record<string, unknown>; line: string | null } | null;
};

/** Print one mapped event as a stream record. */
export function recordEvent(
  out: Output,
  threadId: string,
  event: CliEvent,
  full: boolean,
  textStream: "out" | "err",
): void {
  out.record({ ...event, threadId }, renderEventLine(event, full), textStream);
}

export async function followThread(options: FollowOptions): Promise<FollowResult> {
  const transport = createThreadClient(options.session);
  const subscription = subscribeThread(transport, options.threadId, options.lastSeq);
  const mapper = new RunEventMapper();
  let lastSeq = options.lastSeq;
  let truncated = false;

  try {
    for (;;) {
      const message = await subscription.next(options.deadlineAt);
      switch (message.type) {
        case "live":
          if (options.catchupOnly) return { lastSeq, truncated };
          break;
        case "event": {
          lastSeq = message.event.seq;
          for (const event of mapper.map(message.event)) {
            if (options.present) {
              const shown = options.present(event);
              if (shown)
                options.out.record(
                  { ...shown.value, threadId: options.threadId },
                  shown.line,
                  options.textStream,
                );
            } else
              recordEvent(options.out, options.threadId, event, options.full, options.textStream);
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
    }
  } finally {
    subscription.unsubscribe();
    transport.disconnect();
  }
}
