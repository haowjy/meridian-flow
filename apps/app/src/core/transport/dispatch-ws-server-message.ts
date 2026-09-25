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
  onInterruptResponseError: (threadId: string, error: Error) => void;
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

function isNonFatalInterruptResponseError(
  message: Extract<WsServerMessage, { type: "error" }>,
): boolean {
  // A late/double interrupt response is an allowed race: the server has
  // already resumed or expired the interrupt, and the active run subscription
  // must stay alive to receive the assistant output that follows.
  return (
    Boolean(message.threadId) &&
    (message.error.code === "interrupt_not_pending" ||
      message.error.code === "interrupt_correlation_mismatch")
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

      // After catch-up: a replayed frame is frozen at emit time, so the
      // server-computed live state wins over any stale replayed value.
      for (const handler of subscription.handlers) {
        handler.onLiveState?.(message.state);
      }

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
      const error = wsErrorToMeridianApiError(message);
      if (isNonFatalInterruptResponseError(message)) {
        if (message.threadId) deps.onInterruptResponseError(message.threadId, error);
        return;
      }
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
