import type { FailureOccurrence } from "@meridian/contracts/failures";
import type {
  AskAnswerReply,
  CancelTurnResponse,
  CatalogChannelMessage,
  SequencedEvent,
  ThreadLiveState,
  WsGapCause,
} from "@meridian/contracts/protocol";

import type { AskAnswer, DraftAnswers } from "@meridian/contracts/threads";
import type { SocketClose } from "./socket-ports";

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
  onLiveState?: (state: ThreadLiveState) => void;
  onGap?: (event: ThreadGapEvent) => void;
  onConnectionState?: (state: ConnectionState) => void;
  onClose?: (event: SocketClose) => void;
  onError?: (err: Error) => void;
  onUnavailable?: (failure: FailureOccurrence | null) => void;
}

export type AskAnswerInput = {
  threadId: string;
  askId: string;
  submissionId: string;
  answer: AskAnswer;
};

export type AskAnswerOutcome = AskAnswerReply | { type: "unconfirmed" };

export interface ThreadTransportSubscribeOptions {
  after?: string;
}

export interface ThreadTransport {
  connect(): void;

  disconnect(reason?: "logout" | "app_unmount"): void;

  reconnect(): void;

  onConnectionState(listener: (state: ConnectionState) => void): () => void;

  subscribe(
    threadId: string,
    handlers: ThreadTransportHandlers,
    opts?: ThreadTransportSubscribeOptions,
  ): () => void;

  subscribeCatalog(projectId: string, listener: (hint: CatalogChannelMessage) => void): () => void;

  answerAsk(input: AskAnswerInput): Promise<AskAnswerOutcome>;

  sendAskPresence(input: { threadId: string; askId: string; answers?: DraftAnswers }): boolean;

  cancel(threadId: string, turnId: string): Promise<CancelTurnResponse>;
}
