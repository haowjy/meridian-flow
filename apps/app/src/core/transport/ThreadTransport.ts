/**
 * ThreadTransport — the subscribe/cancel contract between the UI/Copilot adapter
 * and the live agent event stream, plus `ConnectionState` and `ThreadGapEvent`.
 *
 * The single seam that contains transport swaps (WS ↔ test doubles). Production
 * impl is `WsThreadTransport`; consumers depend on this interface, never the impl.
 */
import type {
  CancelTurnResponse,
  SequencedEvent,
  WsClientMessage,
  WsGapCause,
} from "@meridian/contracts/protocol";

/** Transport connection state surfaced to active subscribers. */
export type ConnectionState =
  | { kind: "disconnected" }
  | { kind: "connecting"; attempt: number }
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number; nextRetryAt: number }
  | { kind: "degraded"; attempt: number; nextRetryAt: number }
  | { kind: "terminal"; reason: string; code?: number }
  | { kind: "unauthorized"; reason: string; code?: number };

export type CheckpointRespondInput = Omit<
  Extract<WsClientMessage, { type: "checkpoint.respond" }>,
  "type"
>;

export type ThreadGapEvent = {
  threadId: string;
  cause: WsGapCause;
  fromSeq?: string;
  toSeq?: string;
  message?: string;
  gapCount: number;
};

/**
 * Transport-shaped contract for subscribing to an assistant turn's event stream
 * and cancelling an in-flight run. The production implementation is
 * `WsThreadTransport`; tests may provide local doubles without changing
 * Copilot adapter or UI consumers.
 */
export interface ThreadTransportHandlers {
  onEvent: (event: SequencedEvent) => void;
  onGap?: (event: ThreadGapEvent) => void;
  onConnectionState?: (state: ConnectionState) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (err: Error) => void;
}

export interface ThreadTransportSubscribeOptions {
  /** Server-side cursor for catch-up/replay. */
  after?: string;
}

export interface ThreadTransport {
  /** Proactively open the singleton WebSocket. */
  connect(): void;

  /** Close the singleton WebSocket and clear reconnect timers. */
  disconnect(reason?: "logout" | "app_unmount"): void;

  /** Retry immediately using the aggressive reconnect phase. */
  reconnect(): void;

  /** Subscribe to singleton connection state changes. */
  onConnectionState(listener: (state: ConnectionState) => void): () => void;

  /**
   * Subscribe to a thread's live stream. Returns an unsubscribe fn.
   * Calling unsubscribe must stop all further callbacks immediately.
   */
  subscribe(
    threadId: string,
    handlers: ThreadTransportHandlers,
    opts?: ThreadTransportSubscribeOptions,
  ): () => void;

  /** Send a checkpoint answer over the existing thread WebSocket. */
  respondCheckpoint(input: CheckpointRespondInput): void;

  /** Cancel an in-flight turn via HTTP. */
  cancel(threadId: string, turnId: string): Promise<CancelTurnResponse>;

  /**
   * Token from the latest server `connected` frame on this transport's socket.
   * Sent with message POSTs so the server rejects starts from a stale socket.
   */
  getConnectionToken(): string | undefined;

  /**
   * Resolves once the transport has a connection token from the server
   * `connected` frame. Submit paths await this so runs are always owned.
   */
  awaitConnectionToken(): Promise<string>;
}
