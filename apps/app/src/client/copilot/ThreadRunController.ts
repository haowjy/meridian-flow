/** Owns a thread run from submission through transport recovery. */
import {
  EventType,
  isTerminalTurnStatus,
  readRunFinishedMeta,
  readRunStartedMeta,
  type SubmittedReference,
  type UserMessageBlock,
} from "@meridian/contracts/protocol";
import { type AncestryTurn, type JsonValue, replyReaching } from "@meridian/contracts/threads";
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
import { abortable } from "@/client/chat-submissions/lock";
import type { ThreadStoreActions } from "@/client/stores";
import { announceError } from "@/client/stores";
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
  signal: AbortSignal;
  /** Client-only turn id returned by appendUserTurn for this exact submit. */
  optimisticUserTurnId: string;
};

export type SubmissionPayload = {
  submissionId: string;
  text: string;
  blocks: readonly UserMessageBlock[];
  references: readonly SubmittedReference[];
  activatedSkillSlugs: readonly string[];
};

export type SubmissionOutcome = {
  kind: "accepted" | "rejected" | "ambiguous" | "not-seen" | "abandoned";
  submissionId: string;
};

type SessionFence = () => boolean;

/** A refusal proves rejection; transport, server errors and pending admissions do not. */
export function classifyWriteFailure(error: unknown): "rejected" | "ambiguous" {
  if (error instanceof HttpResponseError || isMeridianApiError(error)) {
    if (error.status === 409 && error.message.includes("admission_pending")) return "ambiguous";
    if (error.status === undefined || (error.status >= 400 && error.status < 500))
      return "rejected";
  }
  return "ambiguous";
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
 * only as the observed run, the successor that names it in `continuesRunId`,
 * or the reply that answers an admitted user turn, never because it came next
 * in the stream or soon after a finish.
 */
type ActiveRun = {
  threadId: string;
  token: number;
  /** The observed run: named by admission or resume, or bound from its start. */
  turnId?: string;
  /** The observed run finished or errored; Stop waits for the next bound start. */
  ended?: boolean;
  /** The observed run's finish reserved a same-lease successor whose start is still due. */
  continuing?: boolean;
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
  private leaseTail: Promise<void> = Promise.resolve();
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

  /** Re-admit a journal-recovered submission under its owning recovery session. */
  recoverSubmission(
    threadId: string,
    payload: SubmissionPayload,
    options: SubmitOptions,
    session: object,
  ): Promise<SubmissionOutcome> {
    return this.dispatch(threadId, payload, options, this.recoveryFence(session));
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

  private async dispatch(
    threadId: string,
    envelope: SubmissionPayload,
    options: SubmitOptions,
    fence: SessionFence,
  ): Promise<SubmissionOutcome> {
    const outcome = (kind: SubmissionOutcome["kind"]): SubmissionOutcome => ({
      kind,
      submissionId: envelope.submissionId,
    });
    const signal = AbortSignal.any([this.accountSignal, options.signal]);
    const current = () => fence() && !signal.aborted;
    if (!current()) return outcome("abandoned");
    const previous = this.leaseTail;
    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.leaseTail = previous.then(() => completed);
    try {
      await abortable(previous, signal);
    } catch {
      release();
      return outcome("abandoned");
    }
    if (!current()) {
      release();
      return outcome("abandoned");
    }
    try {
      let result: Awaited<ReturnType<AppendUserMessageFn>>;
      try {
        result = await abortable(
          this.appendUserMessageFn({
            data: {
              threadId,
              submissionId: envelope.submissionId,
              text: envelope.text,
              blocks: envelope.blocks,
              references: envelope.references,
              activatedSkillSlugs: envelope.activatedSkillSlugs,
            },
            signal,
          }),
          signal,
        );
      } catch (error) {
        if (!current()) return outcome("abandoned");
        if (classifyWriteFailure(error) === "rejected") {
          return outcome("rejected");
        }
        return outcome("ambiguous");
      }
      if (!current()) return outcome("abandoned");
      this.actions.acknowledgeUserTurn(
        threadId,
        options.optimisticUserTurnId,
        result.userTurnId,
        result.snapshotFloorNextSeq,
      );
      this.attachAcceptedRun(threadId, result);
      return outcome("accepted");
    } finally {
      release();
    }
  }

  /** Reconcile a durable journal entry. */
  lookupSubmission(
    threadId: string,
    submissionId: string,
    options: SubmitOptions,
    session: object,
  ): Promise<SubmissionOutcome> {
    return this.reconcile(threadId, submissionId, options, "lookup", this.recoveryFence(session));
  }

  retireSubmission(
    threadId: string,
    submissionId: string,
    options: SubmitOptions,
    session: object,
  ): Promise<SubmissionOutcome> {
    return this.reconcile(threadId, submissionId, options, "retire", this.recoveryFence(session));
  }

  private async reconcile(
    threadId: string,
    submissionId: string,
    options: SubmitOptions,
    operation: "lookup" | "retire",
    fence: SessionFence,
  ): Promise<SubmissionOutcome> {
    const outcome = (kind: SubmissionOutcome["kind"]): SubmissionOutcome => ({
      kind,
      submissionId,
    });
    const signal = AbortSignal.any([this.accountSignal, options.signal]);
    const current = () => fence() && !signal.aborted;
    if (!current()) return outcome("abandoned");
    let result: Awaited<ReturnType<LookupAdmissionFn>> | Awaited<ReturnType<RetireAdmissionFn>>;
    try {
      result = await abortable(
        (operation === "retire" ? this.retireAdmissionFn : this.lookupAdmissionFn)({
          threadId,
          submissionId,
          signal,
        }),
        signal,
      );
    } catch {
      return outcome(current() ? "ambiguous" : "abandoned");
    }
    if (!current()) return outcome("abandoned");
    if (result.kind === "accepted" || result.kind === "already-accepted") {
      this.actions.acknowledgeUserTurn(
        threadId,
        options.optimisticUserTurnId,
        result.userTurnId,
        result.snapshotFloorNextSeq,
      );
      this.attachAcceptedRun(threadId, result);
      return outcome("accepted");
    }
    if (result.kind === "rejected" || result.kind === "retired") {
      return outcome("rejected");
    }
    if (result.kind === "not-seen") return outcome("not-seen");
    return outcome("ambiguous");
  }

  resume(threadId: string, options: SubscribeLiveOptions = {}): void {
    if (this.disposed || this.accountSignal.aborted) return;
    const token = this.startRun(threadId);
    // A handoff resumes at the snapshot's cursor, which can be past the start
    // that answered a carried await: settle those from the applied snapshot.
    const answering = this.settleAnsweredAwaits(this.actions.turns(threadId) ?? []);
    this.attachLiveSubscription(threadId, token, {
      ...options,
      expectedTurnId: options.expectedTurnId ?? answering,
    });
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

  teardown(threadId?: string): void {
    if (threadId && this.activeRun?.threadId !== threadId) return;
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
    // One frame boundary for the whole run: append-only text/reasoning deltas
    // coalesce into a single store update; everything else flushes first.
    const coalescer = new StreamDeltaCoalescer((event) => {
      if (disposed || this.accountSignal.aborted || !this.isActiveToken(token)) return;
      applyAguiEventToStore(this.actions, threadId, event);
    });
    const markDisposed = () => {
      if (!this.accountSignal.aborted) coalescer.flush();
      disposed = true;
    };
    const bind = (turnId: string) => {
      // Flush the previous run before the next enters the durable snapshot owner.
      if (run.turnId !== turnId) coalescer.flush();
      run.turnId = turnId;
      run.ended = false;
      run.continuing = false;
      if (this.abortRequested) {
        this.abortRequested = false;
        this.requestCancel(threadId, turnId);
      }
    };
    const end = (continued: boolean) => {
      run.ended = true;
      run.continuing = continued;
      this.settleIfDone(run);
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
            const { answersUserTurnIds: answers, continuesRunId } = readRunStartedMeta(
              effectiveEvent.rawEvent,
            );
            for (const userTurnId of answers) run.seenAnswers.set(userTurnId, runId);
            const answersAwaited = answers.filter((userTurnId) => run.awaiting.has(userTurnId));
            const unscoped = run.turnId === undefined && !run.ended && run.awaiting.size === 0;
            const successor = continuesRunId !== null && continuesRunId === run.turnId;
            // Any other start is another reply's: a replay from the early
            // admission cursor, another client's send, or a later queued reply.
            if (runId !== run.turnId && !successor && answersAwaited.length === 0 && !unscoped) {
              // One run claim per thread: a foreign start after a continued
              // finish means that lease ended without its successor.
              if (run.continuing) end(false);
              return;
            }
            for (const userTurnId of answersAwaited) run.awaiting.delete(userTurnId);
            bind(runId);
            coalescer.push(effectiveEvent);
            return;
          }

          const live = run.turnId !== undefined && !run.ended;
          const unscoped = run.turnId === undefined && !run.ended && run.awaiting.size === 0;
          // A failed compaction between a continued finish and its successor
          // ends that lease; its error carries no run of ours to render.
          if (effectiveEvent.type === EventType.RUN_ERROR && run.continuing) {
            end(false);
            return;
          }
          // Between replies, events belong to a run this controller did not bind.
          if (!live && !unscoped) return;
          // Same-thread replays can contain events from a superseded run; the
          // runId check is limited to events that carry runId so vocabulary
          // events without run identity still pass through unchanged.
          if (live && "runId" in effectiveEvent && effectiveEvent.runId !== run.turnId) return;
          if (run.turnId) this.actions.ensureAssistantTurn(threadId, run.turnId);

          coalescer.push(effectiveEvent);

          if (effectiveEvent.type === EventType.RUN_FINISHED && live) {
            end(readRunFinishedMeta(effectiveEvent.rawEvent).continued);
          } else if (effectiveEvent.type === EventType.RUN_ERROR) {
            end(false);
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

    // If admission received the turn id from HTTP before RUN_STARTED arrives,
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
        const snapshot = deserializeThreadSnapshot(
          await this.getThreadSnapshotFn({ data: { threadId }, signal }),
        );
        const run = this.activeRun;
        if (signal.aborted || !this.isActiveToken(token) || run?.threadId !== threadId) return;
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
   * state settles them: a continued run's successor or an awaited turn's reply
   * that is still running binds (taking a waiting Stop), one that finished
   * ends that wait (retiring the Stop), and an unanswered turn keeps waiting.
   * No timeout drops a queued message.
   */
  private reconcileWithSnapshot(run: ActiveRun, snapshot: DeserializedThreadSnapshot): void {
    const { turns, liveState } = snapshot;
    // An unscoped follow (no run, nothing awaited) is not waiting on anything to settle.
    const waited = run.ended === true || run.continuing === true || run.awaiting.size > 0;
    const observed = run.turnId ? turns.find((turn) => turn.id === run.turnId) : undefined;
    if (
      observed &&
      !run.ended &&
      isTerminalTurnStatus(observed.status) &&
      liveState.runningTurnId !== observed.id
    )
      run.ended = true;
    let running: string | undefined;
    if (run.continuing && run.turnId) {
      const successor = replyReaching(turns, run.turnId);
      if (successor && !isTerminalTurnStatus(successor.status)) running = successor.id;
      // No successor yet on a sleeping thread: the lease ended without one.
      if (successor || (!liveState.runningTurnId && liveState.status?.kind !== "awake"))
        run.continuing = false;
    }
    running = this.settleAnsweredAwaits(turns) ?? running;
    if (running && (run.ended || run.turnId === undefined)) run.bind?.(running);
    if (waited) this.settleIfDone(run);
  }

  /** Drops each awaited user turn that durable turns show answered; returns a live answering reply. */
  private settleAnsweredAwaits(turns: readonly AncestryTurn[]): string | undefined {
    const run = this.activeRun;
    if (!run) return undefined;
    let running: string | undefined;
    for (const userTurnId of [...run.awaiting]) {
      const reply = replyReaching(turns, userTurnId);
      if (!reply) continue;
      run.awaiting.delete(userTurnId);
      if (!isTerminalTurnStatus(reply.status)) running = reply.id;
    }
    return running;
  }

  /** Settle once nothing this controller follows can still produce a reply. */
  private settleIfDone(run: ActiveRun): void {
    if (this.activeRun !== run) return;
    const live = run.turnId !== undefined && !run.ended;
    if (!live && !run.continuing && run.awaiting.size === 0) this.cleanupActiveRun();
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
