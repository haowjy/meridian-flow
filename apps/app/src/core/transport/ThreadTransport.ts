/**
 * ThreadTransport — the subscribe/cancel contract between the UI/Copilot adapter
 * and the live agent event stream, plus `ConnectionState` and `ThreadGapEvent`.
 *
 * The single seam that contains transport swaps (WS ↔ test doubles). Production
 * impl is `WsThreadTransport`; consumers depend on this interface, never the impl.
 */
import type {
  CancelTurnResponse,
  CatalogWakeHint,
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

/**
 * A non-fatal interrupt-response rejection frame, routed to the interrupt
 * settlement owner rather than the generic thread-error sink. The wire frame
 * carries only `threadId`; the client correlates it to the newest pending
 * response for that thread.
 */
export type ThreadInterruptResponseError = {
  threadId: string;
  error: Error;
};

/**
 * Result of an `interrupt.respond` write. `sent: false` is the only proven
 * "never left the client"; a successful write reports the socket generation it
 * was queued on so a later close can mark it ambiguous instead of pending.
 */
export type InterruptRespondReceipt = { sent: false } | { sent: true; socketGeneration: number };

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

  /** Receive truth-free catalog wake hints over the existing authenticated socket. */
  subscribeCatalog(projectId: string, listener: (hint: CatalogWakeHint) => void): () => void;

  /** Send an interrupt answer over the existing thread WebSocket. */
  respondInterrupt(input: InterruptRespondInput): InterruptRespondReceipt;

  /**
   * Receive non-fatal interrupt-response rejection frames. These never tear
   * down the thread subscription (the run is still valid); they only settle the
   * matching local response. Returns an unsubscribe fn.
   */
  onInterruptResponseError(listener: (event: ThreadInterruptResponseError) => void): () => void;

  /**
   * Notified with the generation of a socket that closed for a non-terminal
   * reason. Responses written on that generation have no server confirmation
   * yet, so the settlement owner marks them ambiguous/retryable. Returns an
   * unsubscribe fn.
   */
  onSocketGenerationClosed(listener: (generation: number) => void): () => void;

  /** Cancel an in-flight turn via HTTP. */
  cancel(threadId: string, turnId: string): Promise<CancelTurnResponse>;
}
