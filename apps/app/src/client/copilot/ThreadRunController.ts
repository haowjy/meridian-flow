/**
 * ThreadRunController — direct run controller for Meridian thread streams.
 *
 * Owns the frontend run lifecycle without AG-UI's client runtime: appends user
 * messages over HTTP, subscribes to `ThreadTransport`, filters stale/cross-run
 * events, applies accepted events directly to ThreadStore, handles deferred
 * cancel, and performs singleton HTTP snapshot recovery on stream gaps.
 */
import { EventType } from "@meridian/contracts/protocol";
import type { JsonValue } from "@meridian/contracts/threads";
import { HttpResponseError } from "@/client/api/http-client";
import { isMeridianApiError } from "@/client/api/meridian-error";
import {
  appendUserMessage,
  deserializeThreadSnapshot,
  getThreadSnapshot,
  lookupUserMessageAdmission,
  retireUserMessageAdmission,
  toThreadSnapshotApplyOptions,
} from "@/client/api/threads-api";
import type { ThreadStoreActions } from "@/client/stores";
import { announceError } from "@/client/stores";
import type { ComposerSubmitEnvelope, ComposerSubmitOutcome } from "@/components/app/composer";
import type { InterruptResponseState } from "@/core/session/interrupt-response";
import { applyAguiEventToStore } from "@/core/session/reduce-turn-event";
import type { InterruptRespondInput, ThreadTransport } from "@/core/transport";
import { StreamDeltaCoalescer } from "./stream-delta-coalescer";

type AppendUserMessageFn = typeof appendUserMessage;
type LookupAdmissionFn = typeof lookupUserMessageAdmission;
type RetireAdmissionFn = typeof retireUserMessageAdmission;

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
  /**
   * Retain the optimistic user row on a proved rejection so the caller can
   * attach edit/retry recovery to it (existing-thread sends and first-send
   * Retry). Omit to drop the row on rejection (writer-directed abandonment).
   */
  keepOptimisticOnFailure?: boolean;
};

/**
 * The dispatch fingerprint a submit needs. `ComposerSubmitEnvelope` is
 * assignable; journal recovery replays the persisted fields without a draft.
 */
export type SubmissionPayload = Pick<
  ComposerSubmitEnvelope,
  "submissionId" | "acceptedRevision" | "text" | "blocks" | "references" | "activatedSkillSlugs"
>;

/**
 * Answers whether the session that started a controller operation still owns it
 * when the operation settles.
 */
type SessionFence = () => boolean;

function isAdmissionPending(error: unknown): boolean {
  return (
    (error instanceof HttpResponseError || isMeridianApiError(error)) &&
    (error.message === "admission_pending" || error.message.includes("admission_pending"))
  );
}

/**
 * A structured refusal or a 4xx proves the endpoint rejected the write, so the
 * journal entry may be retired. A 5xx, a transport failure, or an unstructured
 * response does not prove the write never landed: keep the witness recoverable.
 */
function isDefinitiveWriteRejection(error: unknown): boolean {
  if (isMeridianApiError(error)) {
    return error.status === undefined || (error.status >= 400 && error.status < 500);
  }
  if (error instanceof HttpResponseError) {
    return error.status >= 400 && error.status < 500;
  }
  return false;
}

export type ThreadRunControllerOptions = {
  transport: ThreadTransport;
  actions: ThreadStoreActions;
  appendUserMessageFn?: AppendUserMessageFn;
  lookupAdmissionFn?: LookupAdmissionFn;
  retireAdmissionFn?: RetireAdmissionFn;
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
  private readonly lookupAdmissionFn: LookupAdmissionFn;
  private readonly retireAdmissionFn: RetireAdmissionFn;
  private readonly getThreadSnapshotFn: GetThreadSnapshotFn;

  private activeRun: ActiveRun | null = null;
  private admissionLease: object | null = null;
  private admissionEpoch = 0;
  private recoverySessions = new Set<object>();
  private abortRequested = false;
  private runToken = 0;
  private readonly gapSnapshotsByThreadId = new Map<string, Promise<void>>();
  private readonly unsubscribeInterruptResponseError: () => void;
  private readonly unsubscribeSocketGenerationClosed: () => void;

  constructor(options: ThreadRunControllerOptions) {
    this.transport = options.transport;
    this.actions = options.actions;
    this.appendUserMessageFn = options.appendUserMessageFn ?? appendUserMessage;
    this.lookupAdmissionFn = options.lookupAdmissionFn ?? lookupUserMessageAdmission;
    this.retireAdmissionFn = options.retireAdmissionFn ?? retireUserMessageAdmission;
    this.getThreadSnapshotFn = options.getThreadSnapshotFn ?? getThreadSnapshot;
    this.unsubscribeInterruptResponseError = this.transport.onInterruptResponseError(
      ({ threadId, error }) => this.settleInterruptResponseError(threadId, error),
    );
    this.unsubscribeSocketGenerationClosed = this.transport.onSocketGenerationClosed((generation) =>
      this.actions.markInterruptResponsesForGenerationAmbiguous(generation),
    );
  }

  submit(
    threadId: string,
    payload: SubmissionPayload,
    options: SubmitOptions = {},
  ): Promise<ComposerSubmitOutcome> {
    return this.dispatch(threadId, payload, options, this.admissionFence(this.admissionEpoch));
  }

  /**
   * Re-admit a journal-recovered submission under its owning recovery session.
   * `submit` is fenced by the admission session, but mounting the sibling
   * `useChatThreadSession` tears the run session down in the same React commit
   * that starts recovery (React StrictMode mount → cleanup → re-mount). The
   * recovery fence must not be invalidated by that sibling teardown.
   */
  recoverSubmission(
    threadId: string,
    payload: SubmissionPayload,
    options: SubmitOptions,
    session: object,
  ): Promise<ComposerSubmitOutcome> {
    return this.dispatch(threadId, payload, options, this.recoveryFence(session));
  }

  private admissionFence(admissionEpoch: number): SessionFence {
    return () => this.admissionEpoch === admissionEpoch;
  }

  private recoveryFence(session: object): SessionFence {
    return () => this.recoverySessions.has(session);
  }

  /**
   * Register the mounted recovery owner for the current account/thread.
   * Recovery reconciliation and replay are fenced by this token rather than
   * `admissionEpoch`: the two lifecycles differ, because mounting
   * `useChatThreadSession` tears the run session down (bumping the admission
   * epoch) in the same commit that starts recovery. The token is stable across
   * React StrictMode's mount/cleanup/re-mount for one hook instance, but a
   * genuinely unmounted owner stops matching, so a stale lookup or replay
   * cannot acknowledge, start a run, or retire. Multiple mounted recovery
   * surfaces keep independent tokens.
   */
  beginRecoverySession(session: object): void {
    this.recoverySessions.add(session);
  }

  endRecoverySession(session: object): void {
    this.recoverySessions.delete(session);
  }

  private dropOptimistic(threadId: string, options: SubmitOptions): void {
    if (options.keepOptimisticOnFailure || !options.optimisticUserTurnId) return;
    this.actions.removeOptimisticUserTurn(threadId, options.optimisticUserTurnId);
  }

  private async dispatch(
    threadId: string,
    envelope: SubmissionPayload,
    options: SubmitOptions,
    fence: SessionFence,
  ): Promise<ComposerSubmitOutcome> {
    const outcome = (kind: ComposerSubmitOutcome["kind"]): ComposerSubmitOutcome => ({
      kind,
      submissionId: envelope.submissionId,
      acceptedRevision: envelope.acceptedRevision,
    });
    if (!fence()) return outcome("ambiguous");
    if (this.admissionLease) {
      // Not dispatched. Keep the row and journal so recovery still owns it.
      return outcome("ambiguous");
    }

    const lease = {};
    this.admissionLease = lease;
    try {
      let connectionToken: string;
      try {
        connectionToken = await this.transport.awaitConnectionToken();
      } catch (error) {
        if (!fence()) return outcome("ambiguous");
        // The POST never started: nothing was written, but the connection-token
        // fetch can also fail after the user saw the row. Keep it recoverable.
        announceError(errorMessage(error, "Failed to submit message"));
        return outcome("ambiguous");
      }
      if (!fence()) return outcome("ambiguous");

      let result: Awaited<ReturnType<AppendUserMessageFn>>;
      try {
        result = await this.appendUserMessageFn({
          data: {
            threadId,
            submissionId: envelope.submissionId,
            text: envelope.text,
            blocks: envelope.blocks,
            references: envelope.references,
            connectionToken,
            activatedSkillSlugs: envelope.activatedSkillSlugs,
          },
        });
      } catch (error) {
        if (!fence()) return outcome("ambiguous");
        if (isAdmissionPending(error)) return outcome("ambiguous");
        if (isDefinitiveWriteRejection(error)) {
          this.dropOptimistic(threadId, options);
          return outcome("rejected");
        }
        const reconciled = await this.reconcile(
          threadId,
          envelope.submissionId,
          envelope.acceptedRevision,
          options,
          "lookup",
          fence,
        );
        // A live send cannot conclude "never seen" from a lookup that may race
        // an in-flight admission: keep it ambiguous so recovery owns replay.
        return reconciled.kind === "not-seen" ? outcome("ambiguous") : reconciled;
      }
      if (!fence()) {
        // Accepted by the server, but this session no longer owns the thread.
        // The store is app-scoped, so bridge the local row to the persisted
        // turn anyway: an unbridged row makes the returning session append a
        // second pending row that recovery cannot collapse. Return ambiguous
        // so the stale session keeps the journal for recovery to retire.
        if (options.optimisticUserTurnId) {
          this.actions.acknowledgeUserTurn(
            threadId,
            options.optimisticUserTurnId,
            result.userTurnId,
            result.snapshotFloorNextSeq,
          );
        }
        return outcome("ambiguous");
      }
      if (options.optimisticUserTurnId) {
        this.actions.acknowledgeUserTurn(
          threadId,
          options.optimisticUserTurnId,
          result.userTurnId,
          result.snapshotFloorNextSeq,
        );
      }
      const token = this.startRun(threadId, { pruneAbandonedTurn: true });
      this.attachLiveSubscription(threadId, token, {
        after: result.resumeAfterSeq,
        expectedTurnId: result.assistantTurnId,
      });
      return outcome("accepted");
    } finally {
      // An old completion must not release a newer destination's admission lease.
      if (this.admissionLease === lease) this.admissionLease = null;
    }
  }

  lookup(
    threadId: string,
    envelope: ComposerSubmitEnvelope,
    options: SubmitOptions = {},
  ): Promise<ComposerSubmitOutcome> {
    return this.reconcile(
      threadId,
      envelope.submissionId,
      envelope.acceptedRevision,
      options,
      "lookup",
      this.admissionFence(this.admissionEpoch),
    );
  }

  retire(
    threadId: string,
    envelope: ComposerSubmitEnvelope,
    options: SubmitOptions = {},
  ): Promise<ComposerSubmitOutcome> {
    return this.reconcile(
      threadId,
      envelope.submissionId,
      envelope.acceptedRevision,
      options,
      "retire",
      this.admissionFence(this.admissionEpoch),
    );
  }

  /**
   * Reconcile a durable journal entry. The server keys admissions by
   * `(threadId, submissionId)`, so recovery needs only the identity, not a
   * reconstructed composer envelope or its draft snapshot.
   */
  lookupSubmission(
    threadId: string,
    submissionId: string,
    options: SubmitOptions = {},
    session?: object,
  ): Promise<ComposerSubmitOutcome> {
    return this.reconcile(
      threadId,
      submissionId,
      0,
      options,
      "lookup",
      session ? this.recoveryFence(session) : this.admissionFence(this.admissionEpoch),
    );
  }

  retireSubmission(
    threadId: string,
    submissionId: string,
    options: SubmitOptions = {},
    session?: object,
  ): Promise<ComposerSubmitOutcome> {
    return this.reconcile(
      threadId,
      submissionId,
      0,
      options,
      "retire",
      session ? this.recoveryFence(session) : this.admissionFence(this.admissionEpoch),
    );
  }

  private async reconcile(
    threadId: string,
    submissionId: string,
    acceptedRevision: number,
    options: SubmitOptions,
    operation: "lookup" | "retire",
    fence: SessionFence,
  ): Promise<ComposerSubmitOutcome> {
    const outcome = (kind: ComposerSubmitOutcome["kind"]): ComposerSubmitOutcome => ({
      kind,
      submissionId,
      acceptedRevision,
    });
    if (!fence()) return outcome("ambiguous");
    try {
      const result = await (operation === "retire"
        ? this.retireAdmissionFn
        : this.lookupAdmissionFn)({
        threadId,
        submissionId,
      });
      if (!fence()) {
        // A late accepted result is not bridged into the store, so it must not
        // read as acknowledged. A proved refusal still retires the journal.
        if (result.kind === "rejected" || result.kind === "retired") return outcome("rejected");
        return outcome("ambiguous");
      }
      if (result.kind === "accepted" || result.kind === "already-accepted") {
        if (options.optimisticUserTurnId) {
          this.actions.acknowledgeUserTurn(
            threadId,
            options.optimisticUserTurnId,
            result.userTurnId,
            result.snapshotFloorNextSeq,
          );
        }
        const token = this.startRun(threadId, { pruneAbandonedTurn: true });
        this.attachLiveSubscription(threadId, token, {
          after: result.resumeAfterSeq,
          expectedTurnId: result.assistantTurnId,
        });
        return outcome("accepted");
      }
      if (result.kind === "rejected" || result.kind === "retired") {
        // Recovery keeps the definitive failure on the turn (the writer sees
        // what was refused); the live composer path still drops the row and
        // keeps the draft in the composer.
        if (options.optimisticUserTurnId && !options.keepOptimisticOnFailure) {
          this.actions.removeOptimisticUserTurn(threadId, options.optimisticUserTurnId);
        }
        return outcome("rejected");
      }
      if (result.kind === "not-seen") return outcome("not-seen");
      return outcome("ambiguous");
    } catch {
      return outcome("ambiguous");
    }
  }

  resume(threadId: string, options: SubscribeLiveOptions = {}): void {
    const token = this.startRun(threadId);
    this.attachLiveSubscription(threadId, token, options);
  }

  respondInterrupt(input: InterruptRespondInput): InterruptResponseState {
    // Overlap policy: one in-flight response per tuple. A second click while
    // this tuple is pending returns the existing state and writes nothing, so
    // the server cannot see a duplicate frame and the retained value is not
    // overwritten. Retry after a failed/ambiguous attempt is allowed.
    const existing = this.actions.interruptResponseFor(input);
    if (existing?.status === "pending") return { status: "pending" };

    // The wire envelope allows `unknown`; the component protocol only emits
    // JSON, so the retained retry value is a JsonValue.
    const value = input.value as JsonValue;
    const receipt = this.transport.respondInterrupt(input);
    if (!receipt.sent) {
      // The socket was not open, so the frame never left the client. This is a
      // proven send failure (retryable), not an ambiguous outcome.
      const failure: InterruptResponseState = { status: "failed" };
      this.actions.failInterruptResponse({ ...input, value }, failure);
      return failure;
    }
    // Record the socket generation so a close before any resolution can mark
    // this entry ambiguous (queued, not proven delivered).
    this.actions.beginInterruptResponse({
      ...input,
      value,
      generation: receipt.socketGeneration,
    });
    return { status: "pending" };
  }

  /**
   * Settle a non-fatal interrupt rejection frame. The wire frame carries only
   * `threadId`, so it binds to the newest pending response for that thread and
   * no-ops when none exists. `interrupt_not_pending` after a send means the
   * first attempt likely landed (ambiguous); a correlation mismatch is positive
   * evidence this attempt did not land (retryable failure). Neither tears down
   * the run subscription.
   */
  private settleInterruptResponseError(threadId: string, error: Error): void {
    const pending = this.actions.pendingInterruptResponseForThread(threadId);
    if (!pending) return;
    const code = isMeridianApiError(error) ? error.code : undefined;
    this.actions.failInterruptResponse(pending, {
      status: code === "interrupt_correlation_mismatch" ? "failed" : "ambiguous",
    });
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
    this.admissionLease = null;
    this.runToken += 1;
    this.cleanupActiveRun();
  }

  /** Release controller-lifetime subscriptions (provider unmount). */
  dispose(): void {
    this.teardown();
    this.unsubscribeInterruptResponseError();
    this.unsubscribeSocketGenerationClosed();
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
    // One frame boundary for the whole run: append-only text/reasoning deltas
    // coalesce into a single store update; everything else flushes first.
    const coalescer = new StreamDeltaCoalescer((event) => {
      if (disposed || !this.isActiveToken(token)) return;
      applyAguiEventToStore(this.actions, threadId, event);
    });
    const markDisposed = () => {
      coalescer.flush();
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

          coalescer.push(effectiveEvent);

          if (
            effectiveEvent.type === EventType.RUN_FINISHED ||
            effectiveEvent.type === EventType.RUN_ERROR
          ) {
            this.cleanupActiveRun();
          }
        },
        onError: (error) => {
          if (disposed || !this.isActiveToken(token)) return;
          coalescer.flush();
          this.cleanupActiveRun();
          announceError(errorMessage(error, "Thread stream failed"));
        },
        onGap: ({ threadId: gapThreadId }) => {
          if (disposed || !this.isActiveToken(token)) return;
          coalescer.flush();
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
    // Dispose (flush the coalescer) before clearing `activeRun`: the coalesced
    // apply is gated on `isActiveToken`, so nulling first would drop the last
    // buffered frame on teardown, run switch, and unmount.
    activeRun?.dispose?.();
    activeRun?.unsubscribe?.();
    this.activeRun = null;
  }

  private isActiveToken(token: number): boolean {
    return this.activeRun?.token === token;
  }
}
