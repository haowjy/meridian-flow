import type { Output } from "../../core/output";
import type { Session } from "../../core/session";
import { type CliEvent, RunEventMapper, renderEventLine } from "./events-map";
import { createThreadClient, subscribeThread } from "./transport";

export type FollowResult = {
  lastSeq: string;
  truncated: boolean;
};

export type FollowOptions = {
  session: Session;
  threadId: string;
  lastSeq: string;
  deadlineAt: number;
  out: Output;
  full: boolean;
  textStream: "out" | "err";
  catchupOnly?: boolean;
  present?: (event: CliEvent) => { value: Record<string, unknown>; line: string | null } | null;
};

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
