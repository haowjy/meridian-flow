/**
 * Stateful test runtime for ThreadRunController.
 *
 * The scenario owns a real thread store and an in-memory transport. Tests drive
 * public lifecycle inputs and inspect durable store/transport outcomes instead
 * of assembling action spies for each controller branch.
 */

import type {
  AGUIEvent,
  SendMessageResponse,
  SequencedEvent,
  ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { createThreadCache } from "@/client/stores/thread-store/thread-cache";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import type {
  InterruptRespondInput,
  ThreadTransport,
  ThreadTransportHandlers,
  ThreadTransportSubscribeOptions,
} from "@/core/transport";
import {
  type SubmitOptions,
  type SubscribeLiveOptions,
  ThreadRunController,
} from "../ThreadRunController";

type AppendRequest = {
  data: {
    threadId: string;
    text: string;
    connectionToken?: string;
  };
};

export type ScenarioGate<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

export function scenarioGate<T>(): ScenarioGate<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class ScenarioThreadTransport implements ThreadTransport {
  connectionToken: string | undefined = "conn-test";
  subscriptions: Array<{
    threadId: string;
    handlers: ThreadTransportHandlers;
    options?: ThreadTransportSubscribeOptions;
    active: boolean;
  }> = [];
  cancelRequests: Array<{ threadId: string; turnId: string }> = [];
  interruptResponses: InterruptRespondInput[] = [];

  private readonly connectionWaiters = new Set<(token: string) => void>();

  getConnectionToken(): string | undefined {
    return this.connectionToken;
  }

  awaitConnectionToken(): Promise<string> {
    if (this.connectionToken) return Promise.resolve(this.connectionToken);
    return new Promise((resolve) => this.connectionWaiters.add(resolve));
  }

  connectWith(token: string): void {
    this.connectionToken = token;
    for (const resolve of this.connectionWaiters) resolve(token);
    this.connectionWaiters.clear();
  }

  connect(): void {}
  disconnect(): void {}
  reconnect(): void {}
  onConnectionState(): () => void {
    return () => {};
  }

  subscribe(
    threadId: string,
    handlers: ThreadTransportHandlers,
    options?: ThreadTransportSubscribeOptions,
  ): () => void {
    const subscription = { threadId, handlers, options, active: true };
    this.subscriptions.push(subscription);
    return () => {
      subscription.active = false;
    };
  }

  respondInterrupt(input: InterruptRespondInput): void {
    this.interruptResponses.push(input);
  }

  async cancel(threadId: string, turnId: string) {
    this.cancelRequests.push({ threadId, turnId });
    return { threadId, turnId, status: "cancelled" as const };
  }

  activeSubscription() {
    for (let index = this.subscriptions.length - 1; index >= 0; index -= 1) {
      const subscription = this.subscriptions[index];
      if (subscription?.active) return subscription;
    }
    return undefined;
  }

  emit(event: AGUIEvent, seq = "1", sourceThreadId?: string): void {
    this.activeSubscription()?.handlers.onEvent({
      seq,
      event,
      sourceThreadId,
    } satisfies SequencedEvent);
  }

  emitTo(subscriptionIndex: number, event: AGUIEvent, seq = "1", sourceThreadId?: string): void {
    this.subscriptions[subscriptionIndex]?.handlers.onEvent({
      seq,
      event,
      sourceThreadId,
    } satisfies SequencedEvent);
  }

  fail(error: Error): void {
    this.activeSubscription()?.handlers.onError?.(error);
  }

  gap(threadId: string): void {
    this.activeSubscription()?.handlers.onGap?.({
      threadId,
      cause: "server_restart",
      gapCount: 1,
    });
  }
}

export class ThreadRunScenario {
  readonly store = createThreadStore({
    now: 0,
    threadCache: createThreadCache(new QueryClient()),
  });
  readonly transport = new ScenarioThreadTransport();
  readonly appendRequests: AppendRequest[] = [];
  readonly snapshotRequests: string[] = [];
  readonly controller: ThreadRunController;

  private append: (request: AppendRequest) => Promise<SendMessageResponse>;
  private snapshot: (threadId: string) => Promise<ThreadSnapshotResponse>;

  constructor(
    options: {
      append?: (request: AppendRequest) => Promise<SendMessageResponse>;
      snapshot?: (threadId: string) => Promise<ThreadSnapshotResponse>;
    } = {},
  ) {
    this.append = options.append ?? (async () => defaultSendResponse());
    this.snapshot =
      options.snapshot ??
      (async () => {
        throw new Error("No snapshot result was configured");
      });
    this.controller = new ThreadRunController({
      transport: this.transport,
      actions: this.store.getState(),
      appendUserMessageFn: async (request) => {
        this.appendRequests.push(request);
        return this.append(request);
      },
      getThreadSnapshotFn: async ({ data }) => {
        this.snapshotRequests.push(data.threadId);
        return this.snapshot(data.threadId);
      },
    });
  }

  setAppend(handler: (request: AppendRequest) => Promise<SendMessageResponse>): void {
    this.append = handler;
  }

  setSnapshot(handler: (threadId: string) => Promise<ThreadSnapshotResponse>): void {
    this.snapshot = handler;
  }

  disconnectAdmission(): void {
    this.transport.connectionToken = undefined;
  }

  connect(token = "conn-test"): void {
    this.transport.connectWith(token);
  }

  submit(text: string, options: SubmitOptions = {}, threadId = "thread_1"): Promise<void> {
    return this.controller.submit(threadId, text, options);
  }

  resume(options: SubscribeLiveOptions = {}, threadId = "thread_1"): void {
    this.controller.resume(threadId, options);
  }

  emit(event: AGUIEvent, seq = "1", sourceThreadId?: string): void {
    this.transport.emit(event, seq, sourceThreadId);
  }

  failStream(error: Error): void {
    this.transport.fail(error);
  }

  reportGap(threadId = "thread_1"): void {
    this.transport.gap(threadId);
  }

  turns(threadId = "thread_1") {
    return this.store.getState().turns(threadId) ?? [];
  }

  activeSubscription() {
    return this.transport.activeSubscription();
  }
}

export function defaultSendResponse(
  overrides: Partial<SendMessageResponse> = {},
): SendMessageResponse {
  return {
    threadId: "thread_1",
    userTurnId: "turn-user",
    assistantTurnId: "turn_1",
    resumeAfterSeq: "42",
    snapshotFloorNextSeq: "43",
    status: "accepted",
    ...overrides,
  };
}
