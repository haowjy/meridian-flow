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
  onSubscribed: (message: Extract<WsServerMessage, { type: "subscribed" }>) => void;
  handleGap: (message: Extract<WsServerMessage, { type: "gap" }>) => void;
  send: (payload: unknown) => void;
  onConnected: (message: Extract<WsServerMessage, { type: "connected" }>) => void;
  onAskAnswerReply: (
    message: Extract<WsServerMessage, { type: "ask.answer.ok" | "ask.answer.error" }>,
  ) => void;
  onRequestError: (requestId: string, error: Error, retryable: boolean) => void;
  onThreadError: (threadId: string, error: Error) => void;
  onGlobalError: (error: Error) => void;
};

export function dispatchWsServerMessage(
  message: WsServerMessage,
  deps: WsServerMessageDispatchDeps,
): void {
  switch (message.type) {
    case "connected":
      deps.onConnected(message);
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
