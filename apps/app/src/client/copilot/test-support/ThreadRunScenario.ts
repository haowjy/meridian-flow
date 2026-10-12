/**
 * Stateful test runtime for ThreadRunController.
 *
 * The scenario owns a real thread store and an in-memory transport. Tests drive
 * public lifecycle inputs and inspect durable store/transport outcomes instead
 * of assembling action spies for each controller branch.
 */

import type {
  AdmissionLookup,
  AGUIEvent,
  CancelTurnResponse,
  RetireAdmissionResult,
  SendMessageResponse,
  SequencedEvent,
  ThreadSnapshotResponse,
  Turn,
} from "@meridian/contracts/protocol";
import { goldenAssistantTurn } from "@meridian/contracts/threads";
import { QueryClient } from "@tanstack/react-query";
import { createThreadCache } from "@/client/stores/thread-store/thread-cache";
import { createThreadStore } from "@/client/stores/thread-store/thread-store";
import {
  plainComposerDoc,
  serializeComposerDraft,
} from "@/components/app/composer/composer-document";
import type {
  InterruptRespondInput,
  InterruptRespondReceipt,
  ThreadTransport,
  ThreadTransportHandlers,
  ThreadTransportSubscribeOptions,
} from "@/core/transport";
import {
  type AttachOptions,
  type SubmitOptions,
  ThreadRunController,
} from "../ThreadRunController";

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
  readonly snapshotSignals: AbortSignal[] = [];
  readonly lookupRequests: Array<{ threadId: string; submissionId: string }> = [];
  readonly retireRequests: Array<{ threadId: string; submissionId: string }> = [];
  readonly controller: ThreadRunController;

  private append: (request: AppendRequest) => Promise<SendMessageResponse>;
  private snapshot: (threadId: string) => Promise<ThreadSnapshotResponse>;

  constructor(
    options: {
      append?: (request: AppendRequest) => Promise<SendMessageResponse>;
      snapshot?: (threadId: string) => Promise<ThreadSnapshotResponse>;
      lookup?: (input: { threadId: string; submissionId: string }) => Promise<AdmissionLookup>;
      retire?: (input: {
        threadId: string;
        submissionId: string;
      }) => Promise<RetireAdmissionResult>;
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
      getThreadSnapshotFn: async ({ data, signal }) => {
        this.snapshotRequests.push(data.threadId);
        if (signal) this.snapshotSignals.push(signal);
        return this.snapshot(data.threadId);
      },
    });
    this.controller.activate();
  }

  setAppend(handler: (request: AppendRequest) => Promise<SendMessageResponse>): void {
    this.append = handler;
  }

  setSnapshot(handler: (threadId: string) => Promise<ThreadSnapshotResponse>): void {
    this.snapshot = handler;
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

  /**
   * What a page load does with a settled snapshot that shows an open execution:
   * the snapshot owner merges it, then the resume hook attaches.
   */
  attach(options: Partial<AttachOptions> = {}, threadId = "thread_1"): void {
    const executionId = options.executionId ?? "exec-1";
    const runningTurnId = options.runningTurnId ?? null;
    this.controller.observeSnapshot(
      threadId,
      snapshotResponse({
        turns: runningTurnId
          ? [snapshotTurn(runningTurnId, "assistant", { executionId, status: "streaming" })]
          : [],
        openExecutionId: executionId,
        runningTurnId,
      }),
    );
    this.controller.attach(threadId, {
      executionId,
      after: options.after ?? "0",
      runningTurnId,
    });
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

  closeSocket(generation = this.transport.socketGeneration): void {
    this.transport.emitSocketClose(generation);
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
    steersTurnId: "turn_1",
    resumeAfterSeq: "42",
    snapshotFloorNextSeq: "43",
    status: "accepted",
    ...overrides,
  };
}

/** A durable turn as the snapshot carries it, with its run identity facts. */
export function snapshotTurn(
  id: string,
  role: Turn["role"],
  facts: {
    executionId?: string | null;
    reservedFor?: string[];
    /** A writer message's deliverer once delivered (null: unknown deliverer). */
    deliveredBy?: string | null;
    status?: Turn["status"];
    /** `Turn.position`; by default `snapshotResponse` numbers turns in order. */
    position?: number;
  } = {},
): Turn {
  return {
    ...goldenAssistantTurn(id, "thread_1", facts.status ?? "complete"),
    position: facts.position ?? 0,
    role,
    executionId: facts.executionId ?? null,
    reservedForUserTurnIds: facts.reservedFor ?? [],
    delivery: facts.deliveredBy === undefined ? null : { byTurnId: facts.deliveredBy },
  } as Turn;
}

/** Give unpositioned turns the position after their predecessor, as the server's run. */
function inTranscriptOrder(turns: Turn[]): Turn[] {
  let position = 0;
  return turns.map((turn) => {
    position = turn.position || position + 1;
    return { ...turn, position };
  });
}

/** A thread snapshot: turns, the open execution, and the writer messages still pending. */
export function snapshotResponse(input: {
  turns: Turn[];
  openExecutionId: string | null;
  runningTurnId?: string | null;
  pendingWriterMessages?: string[];
  resumeAfterSeq?: string;
  nextSeq?: string;
}): ThreadSnapshotResponse {
  return {
    threadId: "thread_1",
    thread: { id: "thread_1", userId: "account-1" },
    turns: inTranscriptOrder(input.turns),
    nextSeq: input.nextSeq ?? "100",
    actionRequired: false,
    liveState: {
      runningTurnId: input.runningTurnId ?? null,
      openExecutionId: input.openExecutionId,
      resumeAfterSeq: input.resumeAfterSeq ?? "99",
      pending: { items: (input.pendingWriterMessages ?? []).map(writerPendingItem) },
    },
  } as unknown as ThreadSnapshotResponse;
}

/** A writer message row in the pending inbox projection. */
export function writerPendingItem(id: string) {
  return {
    id,
    seq: 1,
    intent: "message" as const,
    provenance: { kind: "writer" as const, actorId: "account-1" },
    deliveryState: "waiting" as const,
    summary: id,
    enqueuedAt: "2026-01-01T00:00:00.000Z",
  };
}
