/**
 * ThreadRunController — direct run controller for Meridian thread streams.
 *
 * Owns the frontend run lifecycle without AG-UI's client runtime: appends user
 * messages over HTTP, subscribes to `ThreadTransport`, filters stale/cross-run
 * events, applies accepted events directly to ThreadStore, handles deferred
 * cancel, and performs singleton HTTP snapshot recovery on stream gaps.
 */
import { EventType } from "@meridian/contracts/protocol";
import { isMeridianApiError } from "@/client/api/meridian-error";
import {
  appendUserMessage,
  deserializeThreadSnapshot,
  getThreadSnapshot,
  toThreadSnapshotApplyOptions,
} from "@/client/api/threads-api";
import type { ThreadStoreActions } from "@/client/stores";
import { announceError } from "@/client/stores";
import { applyAguiEventToStore } from "@/core/session/reduce-turn-event";
import type { InterruptRespondInput, ThreadTransport } from "@/core/transport";

type AppendUserMessageFn = typeof appendUserMessage;

type GetThreadSnapshotFn = typeof getThreadSnapshot;
type DeserializedThreadSnapshot = ReturnType<typeof deserializeThreadSnapshot>;

export type SubscribeLiveOptions = {
  /** Server-side cursor: last event seq the client has already incorporated. */
  after?: string;
  /** Server-assigned assistant turn id; stale same-thread events for other runs are ignored. */
  expectedTurnId?: string;
};

export type SubmitOptions = {
  /** Client-only turn id returned by appendUserTurn for this exact submit. */
  optimisticUserTurnId?: string;
};

export type ThreadRunControllerOptions = {
  transport: ThreadTransport;
  actions: ThreadStoreActions;
  appendUserMessageFn?: AppendUserMessageFn;
  getThreadSnapshotFn?: GetThreadSnapshotFn;
};

type ActiveRun = {
  threadId: string;
  token: number;
  turnId?: string;
  unsubscribe?: () => void;
  dispose?: () => void;
};

/**
 * Format an error for the a11y announcer / generic error sink.
 *
 * For `MeridianApiError`, the envelope's `code` is appended in parentheses so
 * the surface text honestly reflects what came over the wire (e.g.
 * "Rate limited (rate_limited)"). Otherwise the bare message is used.
 * Plain non-Error values fall through to `fallback` so we never announce
 * "[object Object]".
 */
function errorMessage(error: unknown, fallback: string): string {
  if (isMeridianApiError(error)) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

export class ThreadRunController {
  private readonly transport: ThreadTransport;
  private readonly actions: ThreadStoreActions;
  private readonly appendUserMessageFn: AppendUserMessageFn;
  private readonly getThreadSnapshotFn: GetThreadSnapshotFn;

  private activeRun: ActiveRun | null = null;
  private admissionInFlight = false;
  private admissionEpoch = 0;
  private abortRequested = false;
  private runToken = 0;
  private readonly gapSnapshotsByThreadId = new Map<string, Promise<void>>();

  constructor(options: ThreadRunControllerOptions) {
    this.transport = options.transport;
    this.actions = options.actions;
    this.appendUserMessageFn = options.appendUserMessageFn ?? appendUserMessage;
    this.getThreadSnapshotFn = options.getThreadSnapshotFn ?? getThreadSnapshot;
  }

  async submit(threadId: string, text: string, options: SubmitOptions = {}): Promise<void> {
    if (this.admissionInFlight) {
      if (options.optimisticUserTurnId) {
        this.actions.removeOptimisticUserTurn(threadId, options.optimisticUserTurnId);
      }
      throw new Error("submit already in flight");
    }

    this.admissionInFlight = true;
    const admissionEpoch = this.admissionEpoch;
    let result: Awaited<ReturnType<AppendUserMessageFn>>;

    try {
      const connectionToken = await this.transport.awaitConnectionToken();
      result = await this.appendUserMessageFn({
        data: {
          threadId,
          text,
          connectionToken,
        },
      });
    } catch (error) {
      if (options.optimisticUserTurnId && isMeridianApiError(error)) {
        this.actions.removeOptimisticUserTurn(threadId, options.optimisticUserTurnId);
      }
      throw error;
    } finally {
      this.admissionInFlight = false;
    }

    if (options.optimisticUserTurnId) {
      this.actions.acknowledgeUserTurn(
        threadId,
        options.optimisticUserTurnId,
        result.userTurnId,
        result.snapshotFloorNextSeq,
      );
    }
    if (this.admissionEpoch !== admissionEpoch) return;

    const token = this.startRun(threadId, { pruneAbandonedTurn: true });
    this.attachLiveSubscription(threadId, token, {
      after: result.resumeAfterSeq,
      expectedTurnId: result.assistantTurnId,
    });
  }

  resume(threadId: string, options: SubscribeLiveOptions = {}): void {
    const token = this.startRun(threadId);
    this.attachLiveSubscription(threadId, token, options);
  }

  respondInterrupt(input: InterruptRespondInput): void {
    this.transport.respondInterrupt(input);
  }

  cancel(threadId: string): void {
    const activeRun = this.activeRun;
    if (!activeRun || activeRun.threadId !== threadId) return;

    // The server-assigned turn id may not exist until RUN_STARTED arrives.
    // Keep the abort request sticky for this active run so an early Stop click
    // is not lost while the HTTP append/subscription handshake is still racing.
    this.abortRequested = true;
    if (!activeRun.turnId) return;

    this.abortRequested = false;
    this.requestCancel(activeRun.threadId, activeRun.turnId);
  }

  teardown(): void {
    // Prevent an append already in flight from attaching after teardown.
    this.admissionEpoch += 1;
    this.runToken += 1;
    this.cleanupActiveRun();
  }

  private startRun(threadId: string, options: { pruneAbandonedTurn?: boolean } = {}): number {
    this.runToken += 1;
    this.cleanupActiveRun();
    if (options.pruneAbandonedTurn) {
      // Only a fresh user submit proves the previous non-terminal assistant row
      // is abandoned. Resume/reconnect must preserve the same live row.
      this.actions.pruneStaleAssistantTurns(threadId);
    }
    this.abortRequested = false;
    this.activeRun = { threadId, token: this.runToken };
    return this.runToken;
  }

  private attachLiveSubscription(
    threadId: string,
    token: number,
    { after, expectedTurnId }: SubscribeLiveOptions,
  ): void {
    if (!this.isActiveToken(token)) return;

    let disposed = false;
    const markDisposed = () => {
      disposed = true;
    };

    this.activeRun = {
      ...this.activeRun,
      threadId,
      token,
      turnId: expectedTurnId,
      dispose: markDisposed,
    };

    const unsubscribe = this.transport.subscribe(
      threadId,
      {
        onEvent: ({ event, error, sourceThreadId }) => {
          if (disposed || !this.isActiveToken(token)) return;
          if (sourceThreadId && sourceThreadId !== threadId) return;
          const effectiveEvent =
            event.type === EventType.RUN_ERROR && error
              ? { ...event, message: error.message }
              : event;
          // Same-thread replays can contain events from a superseded run; the
          // runId check is intentionally limited to events that carry runId so
          // vocabulary events without run identity still pass through unchanged.
          if (
            expectedTurnId &&
            "runId" in effectiveEvent &&
            effectiveEvent.runId !== expectedTurnId
          )
            return;

          if (expectedTurnId && effectiveEvent.type !== EventType.RUN_STARTED) {
            this.actions.ensureAssistantTurn(threadId, expectedTurnId);
          }

          if (effectiveEvent.type === EventType.RUN_STARTED) {
            this.activeRun = {
              ...this.activeRun,
              threadId,
              token,
              turnId: effectiveEvent.runId,
              unsubscribe: this.activeRun?.unsubscribe,
              dispose: markDisposed,
            };
            if (this.abortRequested) {
              this.abortRequested = false;
              this.requestCancel(threadId, effectiveEvent.runId);
            }
          }

          applyAguiEventToStore(this.actions, threadId, effectiveEvent);

          if (
            effectiveEvent.type === EventType.RUN_FINISHED ||
            effectiveEvent.type === EventType.RUN_ERROR
          ) {
            this.cleanupActiveRun();
          }
        },
        onError: (error) => {
          if (disposed || !this.isActiveToken(token)) return;
          this.cleanupActiveRun();
          announceError(errorMessage(error, "Thread stream failed"));
        },
        onGap: ({ threadId: gapThreadId }) => {
          if (disposed || !this.isActiveToken(token)) return;
          void this.replaceFromSnapshot(gapThreadId).catch((error) => {
            if (!this.isActiveToken(token)) return;
            this.cleanupActiveRun();
            announceError(errorMessage(error, "Failed to recover thread snapshot"));
          });
        },
      },
      after ? { after } : undefined,
    );

    if (!this.isActiveToken(token)) {
      disposed = true;
      unsubscribe();
      return;
    }

    this.activeRun = {
      ...this.activeRun,
      threadId,
      token,
      unsubscribe,
      dispose: markDisposed,
    };

    // If submit() received the turn id from HTTP before RUN_STARTED arrives,
    // an early cancel can execute now instead of waiting for the stream echo.
    if (this.abortRequested && this.activeRun.turnId) {
      this.abortRequested = false;
      this.requestCancel(this.activeRun.threadId, this.activeRun.turnId);
    }
  }

  private requestCancel(threadId: string, turnId: string): void {
    void this.transport.cancel(threadId, turnId).catch((error) => {
      console.error("Failed to cancel active Meridian turn", error);
    });
  }

  private async replaceFromSnapshot(threadId: string): Promise<void> {
    const existing = this.gapSnapshotsByThreadId.get(threadId);
    if (existing) return existing;

    const recovery = (async () => {
      const snapshot = await this.getThreadSnapshotFn({ data: { threadId } });
      this.applySnapshot(deserializeThreadSnapshot(snapshot));
    })().finally(() => {
      this.gapSnapshotsByThreadId.delete(threadId);
    });

    this.gapSnapshotsByThreadId.set(threadId, recovery);
    return recovery;
  }

  private applySnapshot(snapshot: DeserializedThreadSnapshot): void {
    const { thread, turns } = snapshot;
    this.actions.applyThreadSnapshot(thread, turns, toThreadSnapshotApplyOptions(snapshot));
  }

  private cleanupActiveRun(): void {
    this.abortRequested = false;
    const activeRun = this.activeRun;
    this.activeRun = null;
    activeRun?.dispose?.();
    activeRun?.unsubscribe?.();
  }

  private isActiveToken(token: number): boolean {
    return this.activeRun?.token === token;
  }
}
