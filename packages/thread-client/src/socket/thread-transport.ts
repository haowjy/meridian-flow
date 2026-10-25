/** Thread event subscription, cancellation, and connection-state contract. */
import type { FailureOccurrence } from "@meridian/contracts/failures";
import type {
  CancelTurnResponse,
  CatalogWakeHint,
  SequencedEvent,
  ThreadLiveState,
  WsGapCause,
} from "@meridian/contracts/protocol";

import type { SocketClose } from "./socket-ports";

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

export type ThreadGapEvent = {
  threadId: string;
  cause: WsGapCause;
  fromSeq?: string;
  toSeq?: string;
  message?: string;
  gapCount: number;
};

export interface ThreadTransportHandlers {
  onEvent: (event: SequencedEvent) => void;
  /** Reconciliation snapshot after catch-up; it supersedes replayed live-state frames. */
  onLiveState?: (state: ThreadLiveState) => void;
  onGap?: (event: ThreadGapEvent) => void;
  onConnectionState?: (state: ConnectionState) => void;
  onClose?: (event: SocketClose) => void;
  onError?: (err: Error) => void;
  /** Terminal feed failure, or null after this thread acquired its lease. Retryable errors do not change it. */
  onUnavailable?: (failure: FailureOccurrence | null) => void;
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

  /** Cancel an in-flight turn via HTTP. */
  cancel(threadId: string, turnId: string): Promise<CancelTurnResponse>;
}
