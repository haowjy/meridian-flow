/** Owns a thread run from submission through transport recovery. */
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
import { applyAguiEventToStore, isDurableBlockEvent } from "@/core/session/reduce-turn-event";
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
  keepOptimisticOnFailure?: boolean;
  /** Install mounted durable projections at the accepted cursor before replay starts. */
  activateProjection?: (after: string) => boolean;
};

export type SubmissionPayload = Pick<
  ComposerSubmitEnvelope,
  "submissionId" | "acceptedRevision" | "text" | "blocks" | "references" | "activatedSkillSlugs"
>;

type SessionFence = () => boolean;

/** What a dispatch does when the server accepts the POST after this session has already lost ownership (a fence that no longer matches). */
type StaleAcceptPolicy = "bridge-row" | "leave-row";

function isAdmissionPending(error: unknown): boolean {
  return (
    (error instanceof HttpResponseError || isMeridianApiError(error)) &&
    (error.message === "admission_pending" || error.message.includes("admission_pending"))
  );
}

/** A structured refusal or a 4xx proves the endpoint rejected the write, so the journal entry may be retired. */
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
  accountSignal: AbortSignal;
  accountId: string;
};

type ActiveRun = {
  threadId: string;
  token: number;
  turnId?: string;
  unsubscribe?: () => void;
  dispose?: () => void;
  flush?: () => void;
  splitBoundaryPending?: boolean;
};

function waitForSnapshotRetry(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 250);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Format an error for the a11y announcer / generic error sink. */
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
  private readonly accountSignal: AbortSignal;
  private readonly accountId: string;
  private disposed = false;
  private activationGeneration = 0;

  private activeRun: ActiveRun | null = null;
  private admissionLease: object | null = null;
  private admissionEpoch = 0;
  private recoverySessions = new Set<object>();
  private abortRequested = false;
  private runToken = 0;
  private readonly gapSnapshotsByThreadId = new Map<
    string,
    { token: number; promise: Promise<void>; abort: AbortController }
  >();
  private unsubscribeInterruptResponseError: (() => void) | null = null;
  private unsubscribeSocketGenerationClosed: (() => void) | null = null;

  constructor(options: ThreadRunControllerOptions) {
    this.transport = options.transport;
    this.actions = options.actions;
    this.appendUserMessageFn = options.appendUserMessageFn ?? appendUserMessage;
    this.lookupAdmissionFn = options.lookupAdmissionFn ?? lookupUserMessageAdmission;
    this.retireAdmissionFn = options.retireAdmissionFn ?? retireUserMessageAdmission;
    this.getThreadSnapshotFn = options.getThreadSnapshotFn ?? getThreadSnapshot;
    this.accountSignal = options.accountSignal;
    this.accountId = options.accountId;
  }

  /** Pair provider effect setup with disposal; construction is render-pure. */
  activate(): void {
    if (this.accountSignal.aborted || this.unsubscribeInterruptResponseError) return;
    this.disposed = false;
    const ownerGeneration = ++this.activationGeneration;
    this.unsubscribeInterruptResponseError = this.transport.onInterruptResponseError(
      ({ threadId, error }) => {
        if (
          !this.accountSignal.aborted &&
          !this.disposed &&
          this.activationGeneration === ownerGeneration
        )
          this.settleInterruptResponseError(threadId, error);
      },
    );
    try {
      this.unsubscribeSocketGenerationClosed = this.transport.onSocketGenerationClosed(
        (generation) =>
          !this.accountSignal.aborted &&
          !this.disposed &&
          this.activationGeneration === ownerGeneration &&
          this.actions.markInterruptResponsesForGenerationAmbiguous(generation),
      );
    } catch (error) {
      this.unsubscribeInterruptResponseError?.();
      this.unsubscribeInterruptResponseError = null;
      this.activationGeneration += 1;
      throw error;
    }
  }

  submit(
    threadId: string,
    payload: SubmissionPayload,
    options: SubmitOptions = {},
  ): Promise<ComposerSubmitOutcome> {
    return this.dispatch(
      threadId,
      payload,
      options,
      this.admissionFence(this.admissionEpoch),
      "bridge-row",
    );
  }

  /** Re-admit a journal-recovered submission under its owning recovery session. */
  recoverSubmission(
    threadId: string,
    payload: SubmissionPayload,
    options: SubmitOptions,
    session: object,
  ): Promise<ComposerSubmitOutcome> {
    return this.dispatch(threadId, payload, options, this.recoveryFence(session), "leave-row");
  }

  private admissionFence(admissionEpoch: number): SessionFence {
    return () =>
      !this.disposed && !this.accountSignal.aborted && this.admissionEpoch === admissionEpoch;
  }

  private recoveryFence(session: object): SessionFence {
    const ownerGeneration = this.activationGeneration;
    return () =>
      !this.disposed &&
      !this.accountSignal.aborted &&
      this.activationGeneration === ownerGeneration &&
      this.recoverySessions.has(session);
  }

  /** Register the mounted recovery owner for the current account/thread. */
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
    staleAccept: StaleAcceptPolicy,
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
      let result: Awaited<ReturnType<AppendUserMessageFn>>;
      try {
        result = await this.appendUserMessageFn({
          data: {
            threadId,
            submissionId: envelope.submissionId,
            text: envelope.text,
            blocks: envelope.blocks,
            references: envelope.references,
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
        // A live send bridges the app-scoped row onto the persisted turn (see
        // `StaleAcceptPolicy`); a recovery replay leaves the row so the
        // returning session's own lookup owns the bridge and the retire.
        // Return `ambiguous` either way so the stale session keeps the journal.
        if (staleAccept === "bridge-row" && options.optimisticUserTurnId) {
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
      if (options.activateProjection && !options.activateProjection(result.resumeAfterSeq)) {
        return outcome("ambiguous");
      }
      this.attachAcceptedRun(threadId, result);
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

  /** Reconcile a durable journal entry. */
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
        if (options.activateProjection && !options.activateProjection(result.resumeAfterSeq)) {
          return outcome("ambiguous");
        }
        this.attachAcceptedRun(threadId, result);
        return outcome("accepted");
      }
      if (result.kind === "rejected" || result.kind === "retired") {
        // Callers choose whether a proved refusal remains attached to its
        // optimistic row; the chat surface keeps it for Retry/Edit recovery.
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
    if (this.disposed || this.accountSignal.aborted) return;
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

  private attachAcceptedRun(
    threadId: string,
    result: { assistantTurnId: string | null; resumeAfterSeq: string },
  ): void {
    if (result.assistantTurnId && this.isAttachedToRun(threadId, result.assistantTurnId)) return;
    const token = this.startRun(threadId, {
      pruneAbandonedTurn: result.assistantTurnId == null,
    });
    this.attachLiveSubscription(threadId, token, {
      after: result.resumeAfterSeq,
      ...(result.assistantTurnId ? { expectedTurnId: result.assistantTurnId } : {}),
    });
  }

  private isAttachedToRun(threadId: string, assistantTurnId: string): boolean {
    const activeRun = this.activeRun;
    if (!activeRun || activeRun.threadId !== threadId || !activeRun.unsubscribe) return false;
    // Before RUN_STARTED the client's turn id is unknown; the subscription will
    // publish it. Once known, it must match the run the server reports.
    return activeRun.turnId === undefined || activeRun.turnId === assistantTurnId;
  }

  /** Release controller-lifetime subscriptions (provider unmount). */
  dispose(): void {
    if (this.disposed) return;
    this.teardown();
    this.disposed = true;
    this.activationGeneration += 1;
    this.recoverySessions.clear();
    this.unsubscribeInterruptResponseError?.();
    this.unsubscribeSocketGenerationClosed?.();
    this.unsubscribeInterruptResponseError = null;
    this.unsubscribeSocketGenerationClosed = null;
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
    let awaitingSplitStart = false;
    let splitFinishTimer: ReturnType<typeof setTimeout> | undefined;
    let currentExpectedTurnId = expectedTurnId;
    // One frame boundary for the whole run: append-only text/reasoning deltas
    // coalesce into a single store update; everything else flushes first.
    const coalescer = new StreamDeltaCoalescer((event) => {
      if (disposed || this.accountSignal.aborted || !this.isActiveToken(token)) return;
      applyAguiEventToStore(this.actions, threadId, event);
    });
    const markDisposed = () => {
      if (splitFinishTimer) clearTimeout(splitFinishTimer);
      if (!this.accountSignal.aborted) coalescer.flush();
      disposed = true;
    };

    this.activeRun = {
      ...this.activeRun,
      threadId,
      token,
      turnId: expectedTurnId,
      dispose: markDisposed,
      flush: () => {
        if (!disposed && !this.accountSignal.aborted) coalescer.flush();
      },
    };

    const unsubscribe = this.transport.subscribe(
      threadId,
      {
        onEvent: ({ event, error, sourceThreadId }) => {
          if (disposed || this.accountSignal.aborted || !this.isActiveToken(token)) return;
          if (sourceThreadId && sourceThreadId !== threadId) return;
          const effectiveEvent =
            event.type === EventType.RUN_ERROR && error
              ? { ...event, message: error.message }
              : event;
          // Same-thread replays can contain events from a superseded run; the
          // runId check is intentionally limited to events that carry runId so
          // vocabulary events without run identity still pass through unchanged.
          if (
            currentExpectedTurnId &&
            "runId" in effectiveEvent &&
            effectiveEvent.runId !== currentExpectedTurnId &&
            !(awaitingSplitStart && effectiveEvent.type === EventType.RUN_STARTED)
          )
            return;

          if (isDurableBlockEvent(effectiveEvent)) return;

          if (currentExpectedTurnId && effectiveEvent.type !== EventType.RUN_STARTED) {
            this.actions.ensureAssistantTurn(threadId, currentExpectedTurnId);
          }

          if (effectiveEvent.type === EventType.RUN_STARTED) {
            if (awaitingSplitStart) {
              // A and B are separate assistant turns in one admitted execution.
              // Flush A before B enters the durable snapshot owner, but retain the
              // subscription/token and optimistic writer row across the boundary.
              coalescer.flush();
              awaitingSplitStart = false;
              if (splitFinishTimer) clearTimeout(splitFinishTimer);
            }
            currentExpectedTurnId = effectiveEvent.runId;
            this.activeRun = {
              ...this.activeRun,
              threadId,
              token,
              turnId: effectiveEvent.runId,
              splitBoundaryPending: false,
              unsubscribe: this.activeRun?.unsubscribe,
              dispose: markDisposed,
              flush: () => {
                if (!disposed && !this.accountSignal.aborted) coalescer.flush();
              },
            };
            if (this.abortRequested) {
              this.abortRequested = false;
              this.requestCancel(threadId, effectiveEvent.runId);
            }
          }

          coalescer.push(effectiveEvent);

          if (effectiveEvent.type === EventType.RUN_FINISHED && currentExpectedTurnId) {
            // A same-lease steer is journaled as A-finish then B-start. Keep the
            // mounted owner alive for that transition; an ordinary terminal run
            // settles after the short boundary window.
            awaitingSplitStart = true;
            this.activeRun = { threadId, token, ...this.activeRun, splitBoundaryPending: true };
            splitFinishTimer = setTimeout(() => {
              if (awaitingSplitStart && this.isActiveToken(token)) this.cleanupActiveRun();
            }, 250);
          } else if (effectiveEvent.type === EventType.RUN_ERROR) {
            this.cleanupActiveRun();
          }
        },
        onError: (error) => {
          if (disposed || this.accountSignal.aborted || !this.isActiveToken(token)) return;
          coalescer.flush();
          this.cleanupActiveRun();
          announceError(errorMessage(error, "Thread stream failed"));
        },
        onGap: ({ threadId: gapThreadId }) => {
          if (disposed || this.accountSignal.aborted || !this.isActiveToken(token)) return;
          coalescer.flush();
          void this.replaceFromSnapshot(gapThreadId, token).catch((error) => {
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
      flush: () => {
        if (!disposed && !this.accountSignal.aborted) coalescer.flush();
      },
    };

    // If submit() received the turn id from HTTP before RUN_STARTED arrives,
    // an early cancel can execute now instead of waiting for the stream echo.
    if (this.abortRequested && this.activeRun.turnId) {
      this.abortRequested = false;
      this.requestCancel(this.activeRun.threadId, this.activeRun.turnId);
    }
  }

  flushPendingDeltas(threadId: string): void {
    if (this.activeRun?.threadId === threadId && !this.accountSignal.aborted) {
      this.activeRun.flush?.();
    }
  }

  private requestCancel(threadId: string, turnId: string): void {
    void this.transport.cancel(threadId, turnId).catch((error) => {
      console.error("Failed to cancel active Meridian turn", error);
    });
  }

  private async replaceFromSnapshot(threadId: string, token: number): Promise<void> {
    const existing = this.gapSnapshotsByThreadId.get(threadId);
    if (existing) {
      if (existing.token === token) return existing.promise;
      existing.abort.abort();
      this.gapSnapshotsByThreadId.delete(threadId);
    }

    const abort = new AbortController();
    const signal = AbortSignal.any([this.accountSignal, abort.signal]);
    const recovery = (async () => {
      while (
        this.isActiveToken(token) &&
        !signal.aborted &&
        !this.activeRun?.splitBoundaryPending
      ) {
        const snapshot = deserializeThreadSnapshot(
          await this.getThreadSnapshotFn({ data: { threadId }, signal }),
        );
        if (
          signal.aborted ||
          !this.isActiveToken(token) ||
          this.activeRun?.threadId !== threadId ||
          this.activeRun.splitBoundaryPending
        )
          return;
        if (snapshot.thread.id !== threadId || snapshot.thread.userId !== this.accountId) {
          await waitForSnapshotRetry(signal);
          continue;
        }
        if (this.applySnapshot(snapshot)) return;
        await waitForSnapshotRetry(signal);
      }
    })().finally(() => {
      if (this.gapSnapshotsByThreadId.get(threadId)?.promise === recovery) {
        this.gapSnapshotsByThreadId.delete(threadId);
      }
    });
    this.gapSnapshotsByThreadId.set(threadId, { token, promise: recovery, abort });
    return recovery;
  }

  private applySnapshot(snapshot: DeserializedThreadSnapshot): boolean {
    const { thread, turns } = snapshot;
    return this.actions.applyThreadSnapshot(thread, turns, toThreadSnapshotApplyOptions(snapshot));
  }

  private cleanupActiveRun(): void {
    this.abortRequested = false;
    const activeRun = this.activeRun;
    // Dispose (flush the coalescer) before clearing `activeRun`: the coalesced
    // apply is gated on `isActiveToken`, so nulling first would drop the last
    // buffered frame on teardown, run switch, and unmount.
    activeRun?.dispose?.();
    if (activeRun) {
      const recovery = this.gapSnapshotsByThreadId.get(activeRun.threadId);
      if (recovery?.token === activeRun.token) {
        recovery.abort.abort();
        this.gapSnapshotsByThreadId.delete(activeRun.threadId);
      }
    }
    activeRun?.unsubscribe?.();
    this.activeRun = null;
  }

  private isActiveToken(token: number): boolean {
    return !this.disposed && !this.accountSignal.aborted && this.activeRun?.token === token;
  }
}
