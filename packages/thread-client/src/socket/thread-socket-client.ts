/**
 * ThreadSocketClient — the production `ThreadTransport` over `/api/threads/ws`.
 *
 * Routes thread-domain messages and connection notifications. Per-thread
 * replay requests, outcomes, retries and delivery belong to the subscription registry.
 * `SocketLifecycleController` owns handshake readiness, reconnect, ping timeout
 * and generation fencing; `dispatch-ws-server-message` owns message routing.
 */
import {
  classifyUnavailable,
  type FailureLog,
  type FailureOccurrence,
  noFailureLog,
} from "@meridian/contracts/failures";
import {
  type AGUIEvent,
  type CancelTurnResponse,
  type MeridianError,
  parseWsServerMessage,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import type { DraftAnswers } from "@meridian/contracts/threads";

import { dispatchWsServerMessage } from "./dispatch-ws-server-message";
import { SocketLifecycleController, type SocketLifecycleOptions } from "./socket-lifecycle";
import type {
  AskAnswerInput,
  AskAnswerOutcome,
  ConnectionState,
  ThreadTransport,
  ThreadTransportHandlers,
  ThreadTransportSubscribeOptions,
} from "./thread-transport";
import { DEFAULT_WS_ASK_ANSWER_DEADLINE_MS } from "./ws-thread-socket-utils";
import { WsThreadSubscriptionRegistry } from "./ws-thread-subscription";

export type ThreadSocketClientOptions = SocketLifecycleOptions & {
  url: () => string;
  failureLog?: FailureLog;
  toError: (error: MeridianError) => Error;
  cancelTurn: (threadId: string, turnId: string) => Promise<CancelTurnResponse>;
};

export class ThreadSocketClient implements ThreadTransport {
  private readonly socket: SocketLifecycleController;
  private connectionFailure: FailureOccurrence | null = null;
  private readonly subscriptions = new WsThreadSubscriptionRegistry({
    isConnected: () => this.socket.isServerConnected(),
    failureLog: { record: (record) => (this.options.failureLog ?? noFailureLog).record(record) },
    connectionFailure: () => this.connectionFailure,
    nextRequestId: () => this.nextRequestId(),
    send: (message) => this.send(message),
  });
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>();
  private readonly catalogSubscriptions = new Map<
    string,
    Set<(hint: Extract<WsServerMessage, { type: "context-catalog-hint" }>) => void>
  >();
  /** Unanswered `ask.answer` frames by request id; a close settles every one as unconfirmed. */
  private readonly askAnswers = new Map<
    string,
    { resolve: (outcome: AskAnswerOutcome) => void; deadline: ReturnType<typeof setTimeout> }
  >();
  private wantsConnection = false;
  private requestCounter = 0;

  constructor(private readonly options: ThreadSocketClientOptions) {
    this.socket = new SocketLifecycleController(
      {
        buildUrl: options.url,
        wantsConnection: () => this.wantsConnection,
        onMessage: (data) => this.handleMessage(data),
        onClose: (event) => {
          // The generation that just closed is still `currentGeneration` here
          // (it only advances on the next `startSocket`/`teardown`), so a send
          // tagged with it can be recognized as unconfirmed.
          this.subscriptions.connectionLost();
          this.settleAskAnswers();
          for (const handler of this.subscriptions.handlers()) handler.onClose?.(event);
        },
        onSocketError: () => this.publishError(new Error("WebSocket error")),
        publishConnectionState: (state) => this.publishConnectionState(state),
        publishError: (error) => this.publishError(error),
      },
      options,
    );
  }

  connect(): void {
    this.wantsConnection = true;
    this.socket.ensureConnected();
  }

  disconnect(_reason?: "logout" | "app_unmount"): void {
    this.wantsConnection = false;
    this.socket.teardown();
    this.subscriptions.connectionLost();
    this.settleAskAnswers();
    this.subscriptions.clearAvailability();
    this.endConnectionFailure("moot");
  }

  reconnect(): void {
    if (this.socket.state.kind === "terminal") return;
    this.wantsConnection = true;
    this.socket.reconnectNow();
  }

  onConnectionState(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.socket.state);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  subscribe(
    threadId: string,
    handlers: ThreadTransportHandlers,
    opts?: ThreadTransportSubscribeOptions,
  ): () => void {
    this.subscriptions.join(threadId, handlers, opts?.after);
    handlers.onConnectionState?.(this.socket.state);
    this.ensureConnected();
    return () => this.subscriptions.remove(threadId, handlers);
  }

  subscribeCatalog(
    projectId: string,
    listener: (hint: Extract<WsServerMessage, { type: "context-catalog-hint" }>) => void,
  ): () => void {
    const listeners = this.catalogSubscriptions.get(projectId) ?? new Set();
    const first = listeners.size === 0;
    listeners.add(listener);
    this.catalogSubscriptions.set(projectId, listeners);
    this.ensureConnected();
    if (first && this.socket.isServerConnected()) {
      this.send({ type: "catalog.subscribe", requestId: this.nextRequestId(), projectId });
    }
    return () => {
      const current = this.catalogSubscriptions.get(projectId);
      current?.delete(listener);
      if (current?.size) return;
      this.catalogSubscriptions.delete(projectId);
      if (this.socket.isServerConnected()) {
        this.send({ type: "catalog.unsubscribe", requestId: this.nextRequestId(), projectId });
      }
    };
  }

  answerAsk(input: AskAnswerInput): Promise<AskAnswerOutcome> {
    const requestId = this.nextRequestId();
    if (!this.socket.isServerConnected() || !this.send({ type: "ask.answer", requestId, ...input }))
      return Promise.resolve({ type: "unconfirmed" });
    return new Promise((resolve) =>
      this.askAnswers.set(requestId, {
        resolve,
        deadline: setTimeout(
          () => this.settleAskAnswer(requestId, { type: "unconfirmed" }),
          DEFAULT_WS_ASK_ANSWER_DEADLINE_MS,
        ),
      }),
    );
  }

  sendAskPresence(input: { threadId: string; askId: string; answers: DraftAnswers }): boolean {
    return this.socket.isServerConnected() && this.send({ type: "ask.presence", ...input });
  }

  /** The one settlement for an answer request: its reply, a request error, a close, or its deadline. */
  private settleAskAnswer(requestId: string, outcome: AskAnswerOutcome): boolean {
    const pending = this.askAnswers.get(requestId);
    if (!pending) return false;
    this.askAnswers.delete(requestId);
    clearTimeout(pending.deadline);
    pending.resolve(outcome);
    return true;
  }

  private settleAskAnswers(): void {
    for (const requestId of [...this.askAnswers.keys()])
      this.settleAskAnswer(requestId, { type: "unconfirmed" });
  }

  cancel(threadId: string, turnId: string) {
    return this.options.cancelTurn(threadId, turnId);
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `r${this.requestCounter}`;
  }

  private ensureConnected(): void {
    this.wantsConnection = true;
    this.socket.ensureConnected();
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;

    const message = parseWsServerMessage(data);
    if (!message) return;
    if (message.type === "context-catalog-hint") {
      const projectId = message.scope.kind === "user" ? null : message.scope.projectId;
      const targets = projectId
        ? this.catalogSubscriptions.get(projectId)
        : [...this.catalogSubscriptions.values()].flatMap((listeners) => [...listeners]);
      if (targets) for (const listener of targets) listener(message);
      return;
    }

    dispatchWsServerMessage(message, {
      toError: this.options.toError,
      dispatchSequencedEvent: (threadId, seq, aguiEvent, error, sourceThreadId) =>
        this.dispatchSequencedEvent(threadId, seq, aguiEvent, error, sourceThreadId),
      onSubscribed: (subscribed) => {
        this.subscriptions.handleSubscribed(subscribed);
        if (this.connectionFailure && !this.subscriptions.hasUnavailable(this.connectionFailure))
          this.endConnectionFailure("resolved");
      },
      handleGap: (gap) => this.subscriptions.handleGap(gap),
      send: (payload) => this.send(payload),
      onConnected: () => {
        this.socket.markConnected();
        this.subscriptions.connected();
        for (const projectId of this.catalogSubscriptions.keys()) {
          this.send({ type: "catalog.subscribe", requestId: this.nextRequestId(), projectId });
        }
      },
      onAskAnswerReply: (reply) => this.settleAskAnswer(reply.requestId, reply),
      onRequestError: (requestId, error, retryable) => {
        if (this.settleAskAnswer(requestId, { type: "unconfirmed" })) return;
        this.subscriptions.handleRequestError(requestId, error, retryable);
      },
      onThreadError: (threadId, error) => {
        for (const handler of this.subscriptions.handlers(threadId)) {
          handler.onError?.(error);
        }
      },
      onGlobalError: (error) => this.publishError(error),
    });
  }

  private send(payload: unknown): boolean {
    return this.socket.send(JSON.stringify(payload));
  }

  private dispatchSequencedEvent(
    threadId: string,
    seq: string,
    event: AGUIEvent,
    error?: MeridianError,
    sourceThreadId?: string,
  ): void {
    this.subscriptions.accept(threadId, {
      seq,
      event,
      error,
      sourceThreadId: sourceThreadId ?? threadId,
    });
  }

  private publishConnectionState(state: ConnectionState): void {
    if (state.kind === "terminal" || state.kind === "unauthorized" || state.kind === "reset") {
      if (!this.connectionFailure) {
        this.connectionFailure = {
          occurrenceId: `connection:${globalThis.crypto.randomUUID()}`,
          failure: classifyUnavailable("socket_closed", state.code),
        };
        this.options.failureLog?.record({ ...this.connectionFailure, phase: "recorded" });
      }
      this.subscriptions.connectionUnavailable(this.connectionFailure);
    }

    for (const listener of this.connectionListeners) {
      listener(state);
    }
    for (const handler of this.subscriptions.handlers()) handler.onConnectionState?.(state);
  }

  private endConnectionFailure(end: "resolved" | "moot"): void {
    if (!this.connectionFailure) return;
    this.options.failureLog?.record({ ...this.connectionFailure, phase: "ended", end });
    this.connectionFailure = null;
  }

  private publishError(error: Error): void {
    for (const handler of this.subscriptions.handlers()) handler.onError?.(error);
  }
}
