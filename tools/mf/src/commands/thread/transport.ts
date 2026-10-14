/** Node composition and deadline-bounded subscription queue for the shared thread client. */
import {
  API_THREADS_WS_PATH,
  apiThreadCancelPath,
  type SequencedEvent,
  type ThreadLiveState,
} from "@meridian/contracts/protocol";
import {
  type ThreadGapEvent,
  ThreadSocketClient,
  type ThreadTransport,
} from "@meridian/thread-client";
import WebSocket from "ws";
import { CliError } from "../../core/cli-error";
import type { Session } from "../../core/session";

export function createThreadClient(session: Session): ThreadSocketClient {
  const url = new URL(API_THREADS_WS_PATH, session.serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new ThreadSocketClient({
    url: () => url.toString(),
    webSocketFactory: (address) =>
      new WebSocket(address, { headers: { cookie: session.cookie }, ca: session.ca }),
    toError: (error) =>
      new CliError("protocol", `Thread socket error: ${error.message}`, { details: error }),
    cancelTurn: (threadId, turnId) =>
      session.request("POST", apiThreadCancelPath(threadId, turnId)),
  });
}

type SubscriptionItem =
  | { type: "event"; event: SequencedEvent }
  | { type: "live"; state: ThreadLiveState }
  | { type: "gap"; gap: ThreadGapEvent }
  | { type: "error"; error: Error };

export function subscribeThread(transport: ThreadTransport, threadId: string, after: string) {
  const queue: SubscriptionItem[] = [];
  let wake: (() => void) | undefined;
  const push = (item: SubscriptionItem) => {
    queue.push(item);
    wake?.();
  };
  const unsubscribe = transport.subscribe(
    threadId,
    {
      onEvent: (event) => push({ type: "event", event }),
      onLiveState: (state) => push({ type: "live", state }),
      onGap: (gap) => push({ type: "gap", gap }),
      onError: (error) => {
        // Network errors belong to the shared reconnect policy, not the command outcome.
        if (error instanceof CliError) push({ type: "error", error });
      },
      onConnectionState: (state) => {
        if (state.kind === "unauthorized" || state.kind === "terminal")
          push({
            type: "error",
            error: new CliError(
              "unavailable",
              `Thread socket closed (${state.code ?? "?"} ${state.reason})`,
            ),
          });
      },
    },
    { after },
  );
  return {
    unsubscribe,
    hasQueued: () => queue.length > 0,
    reject: (error: Error) => push({ type: "error", error }),
    async next(deadlineAt: number): Promise<SubscriptionItem> {
      if (Date.now() >= deadlineAt)
        throw new CliError("timeout", "Timed out waiting for thread events");
      if (!queue.length)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            wake = undefined;
            reject(new CliError("timeout", "Timed out waiting for thread events"));
          }, deadlineAt - Date.now());
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          };
        });
      const item = queue.shift();
      if (!item) throw new Error("Subscription woke without an item");
      if (item.type === "error") throw item.error;
      return item;
    },
  };
}
