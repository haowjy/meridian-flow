/**
 * dispatch-ws-server-message — routes a parsed `WsServerMessage` to the right
 * transport callback (sequenced event, gap, connected, error).
 *
 * Pure dispatcher injected with the transport's dependencies, so `ThreadSocketClient`
 * stays focused on socket lifecycle. Owns only the message→callback mapping.
 */
import type { AGUIEvent, MeridianError, WsServerMessage } from "@meridian/contracts/protocol";

export type WsServerMessageDispatchDeps = {
  toError: (error: MeridianError) => Error;
  dispatchSequencedEvent: (
    threadId: string,
    seq: string,
    event: AGUIEvent,
    error?: MeridianError,
    sourceThreadId?: string,
  ) => void;
  /** `subscribed` answers a request; the client decides whether that request is still its own. */
  onSubscribed: (message: Extract<WsServerMessage, { type: "subscribed" }>) => void;
  handleGap: (message: Extract<WsServerMessage, { type: "gap" }>) => void;
  send: (payload: unknown) => void;
  onConnected: (connectionToken: string) => void;
  onAskAnswerReply: (
    message: Extract<WsServerMessage, { type: "ask.answer.ok" | "ask.answer.error" }>,
  ) => void;
  /** An error that names a request. The client ends the request it matches and drops the rest. */
  onRequestError: (requestId: string, error: Error, retryable: boolean) => void;
  /** An error that names a thread but no request. Ends nothing. */
  onThreadError: (threadId: string, error: Error) => void;
  /** An error that names neither. Ends nothing. */
  onGlobalError: (error: Error) => void;
};

export function dispatchWsServerMessage(
  message: WsServerMessage,
  deps: WsServerMessageDispatchDeps,
): void {
  switch (message.type) {
    case "connected":
      deps.onConnected(message.connectionToken);
      return;

    case "subscribed":
      deps.onSubscribed(message);
      return;

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

    case "gap":
      deps.handleGap(message);
      return;

    case "ask.answer.ok":
    case "ask.answer.error":
      deps.onAskAnswerReply(message);
      return;

    case "error": {
      const error = deps.toError(message.error);
      if (message.requestId) {
        deps.onRequestError(message.requestId, error, message.error.retryable);
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
