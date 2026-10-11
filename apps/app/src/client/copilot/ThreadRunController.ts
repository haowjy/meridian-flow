/** Owns a thread run from submission through transport recovery. */
import { EventType, isTerminalTurnStatus, readRunStartedMeta } from "@meridian/contracts/protocol";
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

/**
 * One followed thread. The state model (what binds, what Stop targets, when it
 * settles) is the D62 controller model; the invariant is that a start binds
 * only as the observed run, its same-lease split successor, or the reply that
 * answers an admitted user turn, never because it came next in the stream.
 */
type ActiveRun = {
  threadId: string;
  token: number;
  /** The observed run: named by admission or resume, or bound from its start. */
  turnId?: string;
  /** The observed run finished or errored; Stop waits for the next bound start. */
  ended?: boolean;
  /** The short window after the observed run's finish for its same-lease successor. */
  splitBoundaryPending?: boolean;
  /** User turns admitted with no reply named and not yet seen answered. */
  awaiting: Set<string>;
  /** User turn -> the run whose start named it, for every start this thread showed. */
  seenAnswers: Map<string, string>;
  /** Make a run the observed one (from its start or from durable state). */
  bind?: (turnId: string) => void;
  unsubscribe?: () => void;
  dispose?: () => void;
  flush?: () => void;
};

type SnapshotTurn = DeserializedThreadSnapshot["turns"][number];

/** The reply whose request carried this user turn: the assistant turn reached through only non-assistant turns. */
function replyAnswering(
  turns: readonly SnapshotTurn[],
  byId: ReadonlyMap<string, SnapshotTurn>,
  userTurnId: string,
): SnapshotTurn | undefined {
  const reaches = (reply: SnapshotTurn) => {
    let prev = reply.prevTurnId;
    while (prev) {
      if (prev === userTurnId) return true;
      const turn = byId.get(prev);
      if (!turn || turn.role === "assistant") return false;
      prev = turn.prevTurnId;
    }
    return false;
  };
  const replies = turns.filter((turn) => turn.role === "assistant" && reaches(turn));
  return replies.find((turn) => !isTerminalTurnStatus(turn.status)) ?? replies.at(-1);
}

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

    if (activeRun.turnId && !activeRun.ended) {
      this.abortRequested = false;
      this.requestCancel(activeRun.threadId, activeRun.turnId);
      return;
    }
    // No live run to name yet (the send's reply hasn't started, or the observed
    // one ended before it): the next bound start takes this Stop.
    this.abortRequested = true;
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
    result: { userTurnId: string; assistantTurnId: string | null; resumeAfterSeq: string },
  ): void {
    const named = result.assistantTurnId;
    const run =
      this.activeRun?.threadId === threadId && this.activeRun.unsubscribe ? this.activeRun : null;
    // Null names no reply: the message waits for a new one (idle, or queued
    // behind a write-mode switch, which ends the running reply instead).
    const answeredBy = named ?? run?.seenAnswers.get(result.userTurnId);
    if (run) {
      if (named && run.turnId === undefined) run.bind?.(named);
      if (answeredBy !== undefined && run.turnId === answeredBy) return;
      if (answeredBy === undefined) {
        // This subscription sees every later start, so keep it and wait.
        run.awaiting.add(result.userTurnId);
        return;
      }
    }
    const token = this.startRun(threadId, { pruneAbandonedTurn: named == null });
    if (answeredBy === undefined) this.activeRun?.awaiting.add(result.userTurnId);
    this.attachLiveSubscription(threadId, token, {
      after: result.resumeAfterSeq,
      ...(answeredBy ? { expectedTurnId: answeredBy } : {}),
    });
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
    // Admitted user turns and a waiting Stop are facts about the thread, not
    // about one subscription: a same-thread resubscribe keeps them.
    const previous = this.activeRun?.threadId === threadId ? this.activeRun : null;
    const abortRequested = previous ? this.abortRequested : false;
    this.runToken += 1;
    this.cleanupActiveRun();
    if (options.pruneAbandonedTurn) {
      // Only a fresh user submit proves the previous non-terminal assistant row
      // is abandoned. Resume/reconnect must preserve the same live row.
      this.actions.pruneStaleAssistantTurns(threadId);
    }
    this.abortRequested = abortRequested;
    this.activeRun = {
      threadId,
      token: this.runToken,
      awaiting: previous?.awaiting ?? new Set(),
      seenAnswers: previous?.seenAnswers ?? new Map(),
    };
    return this.runToken;
  }

  private attachLiveSubscription(
    threadId: string,
    token: number,
    { after, expectedTurnId }: SubscribeLiveOptions,
  ): void {
    const run = this.activeRun;
    if (!run || !this.isActiveToken(token)) return;

    let disposed = false;
    let splitFinishTimer: ReturnType<typeof setTimeout> | undefined;
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
    const bind = (turnId: string) => {
      // Flush the previous run before the next enters the durable snapshot owner.
      if (run.turnId !== turnId) coalescer.flush();
      if (splitFinishTimer) clearTimeout(splitFinishTimer);
      run.turnId = turnId;
      run.ended = false;
      run.splitBoundaryPending = false;
      if (this.abortRequested) {
        this.abortRequested = false;
        this.requestCancel(threadId, turnId);
      }
    };
    const end = () => {
      run.ended = true;
      if (run.awaiting.size === 0) this.cleanupActiveRun();
    };

    run.turnId = expectedTurnId;
    run.bind = bind;
    run.dispose = markDisposed;
    run.flush = () => {
      if (!disposed && !this.accountSignal.aborted) coalescer.flush();
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
          if (isDurableBlockEvent(effectiveEvent)) return;

          if (effectiveEvent.type === EventType.RUN_STARTED) {
            const runId = effectiveEvent.runId;
            const answers = readRunStartedMeta(effectiveEvent.rawEvent).answersUserTurnIds;
            for (const userTurnId of answers) run.seenAnswers.set(userTurnId, runId);
            const answersAwaited = answers.filter((userTurnId) => run.awaiting.has(userTurnId));
            const unscoped = run.turnId === undefined && !run.ended && run.awaiting.size === 0;
            // A same-lease steer is journaled as A-finish then B-start, so the
            // split window takes the next start. Any other start that answers
            // nothing this controller admitted is another reply's (a replay
            // from the early admission cursor, or a later queued reply).
            if (
              runId !== run.turnId &&
              !run.splitBoundaryPending &&
              answersAwaited.length === 0 &&
              !unscoped
            )
              return;
            for (const userTurnId of answersAwaited) run.awaiting.delete(userTurnId);
            bind(runId);
            coalescer.push(effectiveEvent);
            return;
          }

          const live = run.turnId !== undefined && !run.ended;
          const unscoped = run.turnId === undefined && !run.ended && run.awaiting.size === 0;
          // Between replies, events belong to a run this controller did not bind.
          if (!live && !unscoped) return;
          // Same-thread replays can contain events from a superseded run; the
          // runId check is limited to events that carry runId so vocabulary
          // events without run identity still pass through unchanged.
          if (live && "runId" in effectiveEvent && effectiveEvent.runId !== run.turnId) return;
          if (run.turnId) this.actions.ensureAssistantTurn(threadId, run.turnId);

          coalescer.push(effectiveEvent);

          if (effectiveEvent.type === EventType.RUN_FINISHED && live) {
            run.ended = true;
            run.splitBoundaryPending = true;
            splitFinishTimer = setTimeout(() => {
              if (!this.isActiveToken(token) || !run.splitBoundaryPending) return;
              run.splitBoundaryPending = false;
              end();
            }, 250);
          } else if (effectiveEvent.type === EventType.RUN_ERROR) {
            end();
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
    run.unsubscribe = unsubscribe;

    // If submit() received the turn id from HTTP before RUN_STARTED arrives,
    // an early cancel can execute now instead of waiting for the stream echo.
    if (this.abortRequested && run.turnId) {
      this.abortRequested = false;
      this.requestCancel(threadId, run.turnId);
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
      while (this.isActiveToken(token) && !signal.aborted) {
        // Recovery waits out a split window rather than racing its successor.
        if (this.activeRun?.splitBoundaryPending) {
          await waitForSnapshotRetry(signal);
          continue;
        }
        const snapshot = deserializeThreadSnapshot(
          await this.getThreadSnapshotFn({ data: { threadId }, signal }),
        );
        const run = this.activeRun;
        if (signal.aborted || !this.isActiveToken(token) || run?.threadId !== threadId) return;
        if (run.splitBoundaryPending) continue;
        if (snapshot.thread.id !== threadId || snapshot.thread.userId !== this.accountId) {
          await waitForSnapshotRetry(signal);
          continue;
        }
        if (this.applySnapshot(snapshot)) {
          this.reconcileWithSnapshot(run, snapshot);
          return;
        }
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

  /**
   * A gap can swallow the starts and ends this controller waits on. Durable
   * state settles them: an awaited turn whose reply finished stops the wait
   * (retiring a Stop aimed at it), a running reply binds, an unanswered turn
   * keeps waiting. No timeout drops a queued message.
   */
  private reconcileWithSnapshot(run: ActiveRun, snapshot: DeserializedThreadSnapshot): void {
    const byId = new Map(snapshot.turns.map((turn) => [turn.id, turn]));
    const waited = run.ended === true || run.awaiting.size > 0;
    const observed = run.turnId ? byId.get(run.turnId) : undefined;
    if (
      observed &&
      !run.ended &&
      isTerminalTurnStatus(observed.status) &&
      snapshot.liveState.runningTurnId !== observed.id
    )
      run.ended = true;
    let running: string | undefined;
    for (const userTurnId of [...run.awaiting]) {
      const reply = replyAnswering(snapshot.turns, byId, userTurnId);
      if (!reply) continue;
      run.awaiting.delete(userTurnId);
      if (!isTerminalTurnStatus(reply.status)) running = reply.id;
    }
    if (running && (run.ended || run.turnId === undefined)) run.bind?.(running);
    if ((waited || run.ended) && run.awaiting.size === 0 && (run.ended || !run.turnId))
      this.cleanupActiveRun();
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
