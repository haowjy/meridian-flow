/**
 * Follows one thread's sequenced event stream over the thread socket: catch-up,
 * live frames, gap resubscription, and seq de-duplication shared by events/tail/send.
 */
import type { ThreadLiveState, WsServerMessage } from "@meridian/contracts/protocol";
import { CliError } from "./cli-error";
import type { Output } from "./output";
import { type CliEvent, RunEventMapper, renderEventLine } from "./run-events";
import type { Session } from "./session";
import { openThreadSocket, type ThreadSocket } from "./thread-socket";

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
  /** Return true to stop following after this event has been emitted. */
  shouldStop?: (event: CliEvent) => boolean;
  /** Test seam. */
  openSocket?: (session: Session) => Promise<ThreadSocket>;
};

function seqAfter(seq: string, lastSeq: string): boolean {
  return BigInt(seq) > BigInt(lastSeq);
}

export async function followThread(options: FollowOptions): Promise<FollowResult> {
  const socket = await (options.openSocket ?? openThreadSocket)(options.session);
  const mapper = new RunEventMapper();
  let lastSeq = options.lastSeq;
  let state: ThreadLiveState | null = null;

  const emit = (event: CliEvent): boolean => {
    options.out.record(
      { ...event, threadId: options.threadId },
      renderEventLine(event, options.full),
      options.textStream,
    );
    return options.shouldStop?.(event) ?? false;
  };

  const consume = (seq: string, message: Parameters<RunEventMapper["map"]>[0]): CliEvent | null => {
    if (!seqAfter(seq, lastSeq)) return null;
    lastSeq = seq;
    for (const event of mapper.map(message)) {
      if (emit(event)) return event;
    }
    return null;
  };

  const subscribe = () => socket.send({ type: "subscribe", threadId: options.threadId, lastSeq });

  try {
    subscribe();
    for (;;) {
      const message: WsServerMessage = await socket.next(options.deadlineAt);
      if ("threadId" in message && message.threadId && message.threadId !== options.threadId) {
        continue;
      }
      switch (message.type) {
        case "subscribed": {
          state = message.state;
          for (const sequenced of message.catchup) {
            const stop = consume(sequenced.seq, sequenced);
            if (stop) return { lastSeq, stoppedBy: stop, state };
          }
          if (options.catchupOnly) return { lastSeq, stoppedBy: null, state };
          break;
        }
        case "event": {
          const stop = consume(message.seq, message);
          if (stop) return { lastSeq, stoppedBy: stop, state };
          break;
        }
        case "gap": {
          // Same rule as the app transport: jump the cursor to what the server can serve.
          options.out.record(
            {
              type: "gap",
              threadId: options.threadId,
              cause: message.cause,
              fromSeq: message.fromSeq ?? null,
              toSeq: message.toSeq ?? null,
            },
            `gap ${message.cause} ${message.fromSeq ?? "?"}..${message.toSeq ?? "?"} (events skipped; ./mf thread view shows the durable state)`,
            options.textStream,
          );
          if (message.toSeq && seqAfter(message.toSeq, lastSeq)) lastSeq = message.toSeq;
          subscribe();
          break;
        }
        case "error":
          throw new CliError("protocol", `Thread socket error: ${message.error.message}`, {
            details: message.error,
          });
        default:
          break;
      }
    }
  } finally {
    socket.close();
  }
}
