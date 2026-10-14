/**
 * Stateful test runtime for ThreadRunController.
 *
 * The scenario owns a real thread store and an in-memory transport. Tests drive
 * public lifecycle inputs and inspect durable store/transport outcomes instead
 * of assembling action spies for each controller branch.
 */

import type {
  AdmissionLookup,
  CancelTurnResponse,
  RetireAdmissionResult,
  SendMessageResponse,
} from "@meridian/contracts/protocol";
import type {
  InterruptRespondInput,
  InterruptRespondReceipt,
  ThreadTransport,
  ThreadTransportHandlers,
  ThreadTransportSubscribeOptions,
} from "@meridian/thread-client";
import { QueryClient } from "@tanstack/react-query";
import { createThreadCache } from "@/client/stores/thread-store/thread-cache";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import { type SubmitOptions, ThreadRunController } from "../ThreadRunController";

type AppendRequest = {
  data: {
    threadId: string;
    submissionId: string;
    text: string;
    blocks: readonly import("@meridian/contracts/protocol").UserMessageBlock[];
    references: readonly import("@meridian/contracts/protocol").SubmittedReference[];
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
  subscriptions: Array<{
    threadId: string;
    handlers: ThreadTransportHandlers;
    options?: ThreadTransportSubscribeOptions;
    active: boolean;
  }> = [];
  cancelRequests: Array<{ threadId: string; turnId: string }> = [];
  interruptResponses: InterruptRespondInput[] = [];
  /** Socket generation reported on a successful interrupt write. */
  socketGeneration = 1;

  private readonly interruptErrorListeners = new Set<{
    listener: (event: { threadId: string; error: Error }) => void;
  }>();

  private readonly socketClosedListeners = new Set<(generation: number) => void>();

  connect(): void {}
  subscribeCatalog(): () => void {
    return () => {};
  }
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

  respondInterrupt(input: InterruptRespondInput): InterruptRespondReceipt {
    this.interruptResponses.push(input);
    return { sent: true, socketGeneration: this.socketGeneration };
  }

  onInterruptResponseError(
    listener: (event: { threadId: string; error: Error }) => void,
  ): () => void {
    const entry = { listener };
    this.interruptErrorListeners.add(entry);
    return () => {
      this.interruptErrorListeners.delete(entry);
    };
  }

  emitInterruptResponseError(threadId: string, error: Error): void {
    for (const { listener } of this.interruptErrorListeners) listener({ threadId, error });
  }

  onSocketGenerationClosed(listener: (generation: number) => void): () => void {
    this.socketClosedListeners.add(listener);
    return () => {
      this.socketClosedListeners.delete(listener);
    };
  }

  emitSocketClose(generation = this.socketGeneration): void {
    for (const listener of this.socketClosedListeners) listener(generation);
  }

  /** What the next cancels answer. */
  cancelStatus: CancelTurnResponse["status"] = "cancelled";

  async cancel(threadId: string, turnId: string): Promise<CancelTurnResponse> {
    this.cancelRequests.push({ threadId, turnId });
    return { threadId, turnId, status: this.cancelStatus };
  }

  activeSubscription() {
    for (let index = this.subscriptions.length - 1; index >= 0; index -= 1) {
      const subscription = this.subscriptions[index];
      if (subscription?.active) return subscription;
    }
    return undefined;
  }
}

export class ThreadRunScenario {
  readonly store = createThreadStore({
    now: 0,
    threadCache: createThreadCache(new QueryClient()),
  });
  readonly transport = new ScenarioThreadTransport();
  readonly appendRequests: AppendRequest[] = [];
  readonly lookupRequests: Array<{ threadId: string; submissionId: string }> = [];
  readonly retireRequests: Array<{ threadId: string; submissionId: string }> = [];
  readonly controller: ThreadRunController;

  private append: (request: AppendRequest) => Promise<SendMessageResponse>;

  constructor(
    options: {
      append?: (request: AppendRequest) => Promise<SendMessageResponse>;
      lookup?: (input: { threadId: string; submissionId: string }) => Promise<AdmissionLookup>;
      retire?: (input: {
        threadId: string;
        submissionId: string;
      }) => Promise<RetireAdmissionResult>;
    } = {},
  ) {
    this.append = options.append ?? (async () => defaultSendResponse());
    this.controller = new ThreadRunController({
      transport: this.transport,
      actions: this.store.getState(),
      accountSignal: new AbortController().signal,
      accountId: "account-1",
      appendUserMessageFn: async (request) => {
        this.appendRequests.push(request);
        return this.append(request);
      },
      lookupAdmissionFn: async (input) => {
        this.lookupRequests.push(input);
        return options.lookup?.(input) ?? { kind: "not-seen", submissionId: input.submissionId };
      },
      retireAdmissionFn: async (input) => {
        this.retireRequests.push(input);
        return (
          options.retire?.(input) ?? {
            kind: "retired",
            submissionId: input.submissionId,
            code: "retired",
          }
        );
      },
    });
    this.controller.activate();
  }

  setAppend(handler: (request: AppendRequest) => Promise<SendMessageResponse>): void {
    this.append = handler;
  }

  submit(text: string, options: Partial<SubmitOptions> = {}, threadId = "thread_1") {
    const session = {};
    this.controller.beginRecoverySession(session);
    const envelope = serializeComposerDraft(plainComposerDoc(text));
    const optimisticUserTurnId =
      options.optimisticUserTurnId ??
      this.store.getState().appendUserTurn(threadId, envelope.blocks).id;
    return this.controller.recoverSubmission(
      threadId,
      envelope,
      { signal: options.signal ?? new AbortController().signal, optimisticUserTurnId },
      session,
    );
  }

  closeSocket(generation = this.transport.socketGeneration): void {
    this.transport.emitSocketClose(generation);
  }

  turns(threadId = "thread_1") {
    return this.store.getState().turns(threadId) ?? [];
  }
}

export function defaultSendResponse(
  overrides: Partial<SendMessageResponse> = {},
): SendMessageResponse {
  return {
    threadId: "thread_1",
    userTurnId: "turn-user",
    runStateVersion: null,
    resumeAfterSeq: "42",
    snapshotFloorNextSeq: "43",
    status: "accepted",
    ...overrides,
  };
}
