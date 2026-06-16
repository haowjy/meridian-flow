/**
 * dispatch-ws-server-message — routes a parsed `WsServerMessage` to the right
 * transport callback (sequenced event, gap, connected, error).
 *
 * Pure dispatcher injected with the transport's dependencies, so `WsThreadTransport`
 * stays focused on socket lifecycle. Owns only the message→callback mapping.
 */
import type { AGUIEvent, MeridianError, WsServerMessage } from "@meridian/contracts/protocol";

import { MeridianApiError } from "@/client/api/meridian-error";

import type { WsThreadSubscriptionRegistry } from "./ws-thread-subscription";

export type WsServerMessageDispatchDeps = {
  subscriptions: WsThreadSubscriptionRegistry;
  dispatchSequencedEvent: (
    threadId: string,
    seq: string,
    event: AGUIEvent,
    error?: MeridianError,
    sourceThreadId?: string,
  ) => void;
  handleGap: (message: Extract<WsServerMessage, { type: "gap" }>) => void | Promise<void>;
  send: (payload: unknown) => void;
  onConnected: (connectionToken: string) => void;
  onThreadError: (threadId: string, error: Error) => void;
  onGlobalError: (error: Error) => void;
};

/**
 * Lift the WS error frame's structured `MeridianError` into a `MeridianApiError`,
 * preserving `code`/`retryable`/`source`/`details` on the wire — earlier this
 * collapsed to `new Error("text (code)")` and dropped every structured field.
 * Consumers receive an `Error` (back-compat) but may downcast via
 * `isMeridianApiError` to read the envelope.
 */
function wsErrorToMeridianApiError(
  message: Extract<WsServerMessage, { type: "error" }>,
): MeridianApiError {
  return new MeridianApiError(message.error);
}

function isNonFatalCheckpointResponseError(
  message: Extract<WsServerMessage, { type: "error" }>,
): boolean {
  // A late/double checkpoint response is an allowed race: the server has
  // already resumed or expired the checkpoint, and the active run subscription
  // must stay alive to receive the assistant output that follows.
  return (
    Boolean(message.threadId) &&
    (message.error.code === "checkpoint_not_pending" ||
      message.error.code === "checkpoint_correlation_mismatch")
  );
}

export function dispatchWsServerMessage(
  message: WsServerMessage,
  deps: WsServerMessageDispatchDeps,
): void {
  switch (message.type) {
    case "connected":
      deps.onConnected(message.connectionToken);
      return;

    case "subscribed": {
      const subscription = deps.subscriptions.get(message.threadId);
      if (!subscription) return;
      subscription.gapCount = 0;
      subscription.serverSubscribed = true;

      for (const next of message.catchup) {
        deps.dispatchSequencedEvent(
          message.threadId,
          next.seq,
          next.event,
          next.error,
          next.sourceThreadId,
        );
      }

      // Do NOT advance lastSeq from nextSeq — it's "head + 1", not a delivered event seq.
      return;
    }

    case "event": {
      deps.dispatchSequencedEvent(
        message.threadId,
        message.seq,
        message.event,
        message.error,
        message.sourceThreadId,
      );
      return;
    }

    case "gap": {
      void deps.handleGap(message);
      return;
    }

    case "error": {
      if (isNonFatalCheckpointResponseError(message)) return;
      const error = wsErrorToMeridianApiError(message);
      if (message.threadId) {
        deps.onThreadError(message.threadId, error);
        return;
      }
      deps.onGlobalError(error);
      return;
    }

    case "ping":
      deps.send({ type: "pong" });
      return;

    default:
      return;
  }
}
