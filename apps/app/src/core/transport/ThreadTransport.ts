/** Thread event subscription, cancellation, and connection-state contract. */
import type {
  CancelTurnResponse,
  CatalogWakeHint,
  SequencedEvent,
  ThreadLiveState,
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
  | { kind: "reset"; reason: string; code?: number }
  | { kind: "unauthorized"; reason: string; code?: number };

export type InterruptRespondInput = Omit<
  Extract<WsClientMessage, { type: "interrupt.respond" }>,
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

export type ThreadInterruptResponseError = {
  threadId: string;
  error: Error;
};

/** Only `sent: false` proves the response never left the client. */
export type InterruptRespondReceipt = { sent: false } | { sent: true; socketGeneration: number };

export interface ThreadTransportHandlers {
  onEvent: (event: SequencedEvent) => void;
  /** Reconciliation snapshot after catch-up; it supersedes replayed live-state frames. */
  onLiveState?: (state: ThreadLiveState) => void;
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

  /** Receive truth-free catalog wake hints over the existing authenticated socket. */
  subscribeCatalog(projectId: string, listener: (hint: CatalogWakeHint) => void): () => void;

  /** Send an interrupt answer over the existing thread WebSocket. */
  respondInterrupt(input: InterruptRespondInput): InterruptRespondReceipt;

  /** Rejections settle a response attempt without closing the thread stream. */
  onInterruptResponseError(listener: (event: ThreadInterruptResponseError) => void): () => void;

  /** Responses on a closed generation are ambiguous until server reconciliation. */
  onSocketGenerationClosed(listener: (generation: number) => void): () => void;

  /** Cancel an in-flight turn via HTTP. */
  cancel(threadId: string, turnId: string): Promise<CancelTurnResponse>;
}
