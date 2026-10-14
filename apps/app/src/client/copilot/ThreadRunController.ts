/** Owns a thread run from submission through transport recovery. */
import {
  type AGUIEvent,
  type CancelTurnResponse,
  EventType,
  EXECUTION_ENDED_EVENT,
  MESSAGES_DELIVERED_EVENT,
  parseSeq,
  type SubmittedReference,
  type ThreadSnapshotResponse,
  type UserMessageBlock,
} from "@meridian/contracts/protocol";
import type { JsonValue, ThreadPendingInbox } from "@meridian/contracts/threads";
import type { InterruptRespondInput, ThreadTransport } from "@meridian/thread-client";
import { isDurableBlockEvent } from "@meridian/thread-client";
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
import { threadAvailability } from "@/client/chat-submissions/thread-availability";
import type { ThreadStoreActions } from "@/client/stores";
import { announceError } from "@/client/stores";
import type { InterruptResponseState } from "@/core/session/interrupt-response";
import {
  EMPTY_THREAD_PENDING_INBOX,
  owedWriterMessageIds,
  pendingInboxFromEvent,
} from "@/features/chat/pending-inbox";
import {
  EMPTY_RUN_FACTS,
  INITIAL_RUN_FOLLOW,
  isBound,
  type RunFacts,
  type RunFollow,
  type RunFollowInput,
  type RunFollowView,
  stepRunFollow,
  viewRunFollow,
} from "./run-follow";
import { StreamDeltaCoalescer } from "./stream-delta-coalescer";

type AppendUserMessageFn = typeof appendUserMessage;
type LookupAdmissionFn = typeof lookupUserMessageAdmission;
type RetireAdmissionFn = typeof retireUserMessageAdmission;

type GetThreadSnapshotFn = typeof getThreadSnapshot;

/** Attach to the open execution a settled snapshot shows. */
export type AttachOptions = {
  executionId: string;
  /** Server-side cursor: last event seq the snapshot already incorporated. */
  after: string;
  /** The reply streaming at the snapshot, which un-addressed stream deltas belong to. */
  runningTurnId?: string | null;
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
  kind:
    | "accepted"
    | "rejected"
    | "ambiguous"
    | "not-seen"
    | "abandoned"
    | "deleted"
    | "project-deleted";
  submissionId: string;
};

/**
 * What the composer reads: the controller follows work for this chat
 * (`following`), and none of it runs yet (`waiting`: messages are owed, but no
 * execution that took one on is running).
 */
export type RunFollowStatus = { following: boolean; waiting: boolean };

const SETTLED: RunFollowStatus = { following: false, waiting: false };
const RUNNING: RunFollowStatus = { following: true, waiting: false };
const WAITING: RunFollowStatus = { following: true, waiting: true };

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

/** The live stream feeding the store while a thread is unsettled. */
type Subscription = {
  token: number;
  /** The reply un-addressed stream deltas belong to (one run claim per thread). */
  streamTurn?: string;
  /**
   * The seq `streamTurn` was observed at. A late HTTP snapshot is read before
   * newer starts and ends this stream already applied, so it must not move it.
   */
  streamSeq: string | null;
  unsubscribe?: () => void;
  dispose: () => void;
  flush: () => void;
};

/**
 * One thread's follow: the pure rule's state plus where its obligations come
 * from. What binds, what Stop targets and when it settles is `run-follow.ts`.
 */
type Follow = {
  threadId: string;
  rule: RunFollow;
  /** `viewRunFollow(rule)`, recomputed only when `step` changes the rule (stream deltas read it). */
  view: RunFollowView;
  /** The latest pending projection's writer messages, and the seq it was read at. */
  pending: { ids: readonly string[]; seq: string | null };
  /** Admitted messages no pending projection has shown yet (it will, before delivering them). */
  admitted: Set<string>;
  status: RunFollowStatus;
  subscription: Subscription | null;
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

function isRunIdentityEvent(event: AGUIEvent): boolean {
  return (
    event.type === EventType.CUSTOM &&
    (event.name === MESSAGES_DELIVERED_EVENT || event.name === EXECUTION_ENDED_EVENT)
  );
}

/** True when `seq` is older than `than`; an unparseable seq is never older. */
function isOlderSeq(seq: string | null, than: string | null): boolean {
  if (seq === null || than === null) return false;
  const a = parseSeq(seq);
  const b = parseSeq(than);
  return a !== null && b !== null && BigInt(a) < BigInt(b);
}

/**
 * Point un-addressed deltas at `turnId` as of `seq`, unless this stream already
 * observed a newer start or end. `onlyIfUnset` keeps a hint from replacing a
 * known reply.
 */
function routeStream(
  subscription: Subscription,
  turnId: string | undefined,
  seq: string | null,
  onlyIfUnset = false,
): void {
  if (onlyIfUnset && subscription.streamTurn !== undefined) return;
  if (isOlderSeq(seq, subscription.streamSeq)) return;
  subscription.streamTurn = turnId;
  if (seq !== null) subscription.streamSeq = seq;
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

  private readonly follows = new Map<string, Follow>();
  private readonly listeners = new Set<() => void>();
  private recoverySessions = new Set<object>();
  private subscriptionToken = 0;
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
      const availability = threadAvailability(error, this.accountId);
      if (availability === "deleted" || availability === "project-deleted")
        return outcome(availability);
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
    } catch (error) {
      if (!current()) return outcome("abandoned");
      const availability = threadAvailability(error, this.accountId);
      if (availability === "deleted" || availability === "project-deleted")
        return outcome(availability);
      return outcome("ambiguous");
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

  /**
   * Follow the open execution a snapshot shows. Only while settled: an
   * unsettled thread already follows what its owed messages need, and a Stop
   * waiting there must not land on attached work.
   */
  attach(threadId: string, options: AttachOptions): void {
    if (this.disposed || this.accountSignal.aborted) return;
    const follow = this.followFor(threadId);
    // The rule refuses the attach while unsettled; the step still reopens a lost stream.
    this.step(follow, { kind: "attach", executionId: options.executionId }, options.after);
    if (follow.subscription && options.runningTurnId)
      routeStream(follow.subscription, options.runningTurnId, options.after, true);
  }

  /** Merge a durable snapshot's facts and pending projection (the mounted snapshot owner's feed). */
  observeSnapshot(threadId: string, snapshot: ThreadSnapshotResponse): void {
    if (this.disposed || this.accountSignal.aborted) return;
    const follow = this.followFor(threadId);
    this.mergeSnapshot(follow, snapshot);
  }

  /** Merge a live `meridian.inbox.changed` projection read at `seq`. */
  observePending(threadId: string, pending: ThreadPendingInbox, seq: string): void {
    if (this.disposed || this.accountSignal.aborted) return;
    this.mergePending(this.followFor(threadId), pending, seq);
  }

  /**
   * The run identity facts this controller has merged for a thread (stream and
   * snapshots); a new value only when they change, for `useSyncExternalStore`.
   */
  runFacts(threadId: string): RunFacts {
    return this.follows.get(threadId)?.rule.facts ?? EMPTY_RUN_FACTS;
  }

  /** The composer's view of this thread's follow; stable per state for `useSyncExternalStore`. */
  runFollowStatus(threadId: string): RunFollowStatus {
    return this.follows.get(threadId)?.status ?? SETTLED;
  }

  /** Called when any thread's follow status or run facts change. */
  subscribeRunFollow(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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

  /** The composer's Stop: cancel the rule's target, or wait for work on what is owed now. */
  cancel(threadId: string): void {
    const follow = this.follows.get(threadId);
    if (!follow) return;
    this.step(follow, { kind: "stop" });
  }

  teardown(threadId?: string): void {
    for (const follow of [...this.follows.values()]) {
      if (threadId && follow.threadId !== threadId) continue;
      this.closeSubscription(follow);
      this.follows.delete(follow.threadId);
      // Its status reads as settled and its facts as empty from here.
      this.notify();
    }
  }

  /**
   * The lock-holding tab's admission. The message is pending at this point,
   * and the stream from `resumeAfterSeq` carries the projection that shows it;
   * `steersTurnId` is the reply it was steered into, a Stop hint.
   */
  private attachAcceptedRun(
    threadId: string,
    result: { userTurnId: string; steersTurnId: string | null; resumeAfterSeq: string },
  ): void {
    if (this.disposed || this.accountSignal.aborted) return;
    const follow = this.followFor(threadId);
    // Only a fresh send onto an idle follow proves an earlier non-terminal
    // assistant row is abandoned; a live subscription still owns its rows.
    if (!follow.subscription && result.steersTurnId === null)
      this.actions.pruneStaleAssistantTurns(threadId);
    if (!follow.rule.facts.deliveries.has(result.userTurnId)) {
      follow.admitted.add(result.userTurnId);
      this.step(follow, this.obligationsInput(follow), result.resumeAfterSeq);
    }
    if (result.steersTurnId) {
      this.step(follow, { kind: "steer", turnId: result.steersTurnId }, result.resumeAfterSeq);
      if (follow.subscription)
        routeStream(follow.subscription, result.steersTurnId, result.resumeAfterSeq, true);
    }
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

  flushPendingDeltas(threadId: string): void {
    if (!this.accountSignal.aborted) this.follows.get(threadId)?.subscription?.flush();
  }

  private followFor(threadId: string): Follow {
    let follow = this.follows.get(threadId);
    if (!follow) {
      follow = {
        threadId,
        rule: INITIAL_RUN_FOLLOW,
        view: viewRunFollow(INITIAL_RUN_FOLLOW),
        pending: { ids: [], seq: null },
        admitted: new Set(),
        status: SETTLED,
        subscription: null,
      };
      this.follows.set(threadId, follow);
    }
    return follow;
  }

  private obligationsInput(follow: Follow): RunFollowInput {
    for (const id of follow.admitted)
      if (follow.pending.ids.includes(id) || follow.rule.facts.deliveries.has(id))
        follow.admitted.delete(id);
    return { kind: "obligations", userTurnIds: [...follow.pending.ids, ...follow.admitted] };
  }

  private mergePending(follow: Follow, pending: ThreadPendingInbox, seq: string | null): void {
    if (isOlderSeq(seq, follow.pending.seq)) return;
    follow.pending = { ids: owedWriterMessageIds(pending), seq };
    this.step(follow, this.obligationsInput(follow), seq ?? undefined);
  }

  private mergeSnapshot(follow: Follow, snapshot: ThreadSnapshotResponse): void {
    const { liveState } = snapshot;
    this.step(follow, { kind: "snapshot", snapshot }, liveState.resumeAfterSeq);
    this.mergePending(
      follow,
      liveState.pending ?? EMPTY_THREAD_PENDING_INBOX,
      liveState.resumeAfterSeq,
    );
    // The snapshot's facts merge whatever its age; its running reply routes
    // deltas only when the stream has seen nothing newer.
    if (follow.subscription && liveState.runningTurnId)
      routeStream(follow.subscription, liveState.runningTurnId, liveState.resumeAfterSeq);
  }

  /**
   * Apply one rule input, then act on it: send the cancel it names, open the
   * stream (from `after`) while unsettled, close it once settled.
   */
  private step(follow: Follow, input: RunFollowInput, after?: string): void {
    const { follow: rule, cancel } = stepRunFollow(follow.rule, input);
    const factsChanged = rule.facts !== follow.rule.facts;
    if (rule !== follow.rule) {
      follow.rule = rule;
      follow.view = viewRunFollow(rule);
    }
    const { view } = follow;
    if (cancel) this.requestCancel(follow, cancel);
    if (view.settled) this.closeSubscription(follow);
    else if (!follow.subscription && after !== undefined) this.openSubscription(follow, after);
    const status = view.settled ? SETTLED : view.running.size > 0 ? RUNNING : WAITING;
    const statusChanged = follow.status !== status;
    follow.status = status;
    if (statusChanged || factsChanged) this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private openSubscription(follow: Follow, after: string): void {
    const { threadId } = follow;
    const token = ++this.subscriptionToken;
    const live = () =>
      !this.disposed && !this.accountSignal.aborted && follow.subscription?.token === token;
    // One frame boundary for the stream: append-only text/reasoning deltas
    // coalesce into a single store update; everything else flushes first.
    const coalescer = new StreamDeltaCoalescer((event) => {
      if (live()) this.actions.applyTurnEvent(threadId, event);
    });
    let lastPushedTurn: string | undefined;
    const subscription: Subscription = {
      token,
      streamSeq: after,
      dispose: () => {
        if (!this.accountSignal.aborted) coalescer.flush();
      },
      flush: () => {
        if (live()) coalescer.flush();
      },
    };
    follow.subscription = subscription;
    const push = (turnId: string, event: AGUIEvent) => {
      // Flush the previous reply before the next enters the durable snapshot owner.
      if (lastPushedTurn !== undefined && lastPushedTurn !== turnId) coalescer.flush();
      lastPushedTurn = turnId;
      coalescer.push(event);
    };

    const unsubscribe = this.transport.subscribe(
      threadId,
      {
        onEvent: ({ event, error, seq, sourceThreadId }) => {
          if (!live()) return;
          if (sourceThreadId && sourceThreadId !== threadId) return;
          const effectiveEvent =
            event.type === EventType.RUN_ERROR && error
              ? { ...event, message: error.message }
              : event;
          if (isDurableBlockEvent(effectiveEvent)) return;
          const pending = pendingInboxFromEvent(effectiveEvent);
          if (pending) {
            this.mergePending(follow, pending, seq);
            return;
          }
          if (isRunIdentityEvent(effectiveEvent)) {
            // Flush first: an execution's end can settle and close this stream.
            coalescer.flush();
            this.step(follow, { kind: "event", event: effectiveEvent });
            return;
          }
          if (effectiveEvent.type === EventType.RUN_STARTED) {
            this.step(follow, { kind: "event", event: effectiveEvent });
            if (!live()) return;
            routeStream(subscription, effectiveEvent.runId, seq);
            if (isBound(follow.rule, effectiveEvent.runId, follow.view))
              push(effectiveEvent.runId, effectiveEvent);
            return;
          }
          const turnId =
            "runId" in effectiveEvent && typeof effectiveEvent.runId === "string"
              ? effectiveEvent.runId
              : subscription.streamTurn;
          // Another execution's events, or a reply this client does not follow.
          if (!turnId || !isBound(follow.rule, turnId, follow.view)) return;
          this.actions.ensureAssistantTurn(threadId, turnId);
          push(turnId, effectiveEvent);
          if (
            (effectiveEvent.type === EventType.RUN_FINISHED ||
              effectiveEvent.type === EventType.RUN_ERROR) &&
            subscription.streamTurn === turnId
          )
            routeStream(subscription, undefined, seq);
        },
        onError: (error) => {
          if (!live()) return;
          coalescer.flush();
          this.closeSubscription(follow);
          announceError(errorMessage(error, "Thread stream failed"));
        },
        onGap: ({ threadId: gapThreadId }) => {
          if (!live()) return;
          coalescer.flush();
          void this.replaceFromSnapshot(follow, gapThreadId, token).catch((error) => {
            if (follow.subscription?.token !== token) return;
            this.closeSubscription(follow);
            announceError(errorMessage(error, "Failed to recover thread snapshot"));
          });
        },
      },
      { after },
    );
    if (!live()) {
      unsubscribe();
      return;
    }
    subscription.unsubscribe = unsubscribe;
  }

  private closeSubscription(follow: Follow): void {
    const subscription = follow.subscription;
    if (!subscription) return;
    // Dispose (flush the coalescer) before clearing the subscription: the
    // coalesced apply is gated on it, so clearing first would drop the last
    // buffered frame on settle, teardown and unmount.
    subscription.dispose();
    const recovery = this.gapSnapshotsByThreadId.get(follow.threadId);
    if (recovery?.token === subscription.token) {
      recovery.abort.abort();
      this.gapSnapshotsByThreadId.delete(follow.threadId);
    }
    follow.subscription = null;
    subscription.unsubscribe?.();
  }

  private requestCancel(follow: Follow, turnId: string): void {
    void this.transport.cancel(follow.threadId, turnId).then(
      (answer: CancelTurnResponse) => {
        if (this.follows.get(follow.threadId) !== follow) return;
        this.step(follow, { kind: "cancel-answer", turnId, status: answer.status });
      },
      (error) => {
        console.error("Failed to cancel active Meridian turn", error);
      },
    );
  }

  private async replaceFromSnapshot(
    follow: Follow,
    threadId: string,
    token: number,
  ): Promise<void> {
    const existing = this.gapSnapshotsByThreadId.get(threadId);
    if (existing) {
      if (existing.token === token) return existing.promise;
      existing.abort.abort();
      this.gapSnapshotsByThreadId.delete(threadId);
    }

    const current = () =>
      !this.disposed && !this.accountSignal.aborted && follow.subscription?.token === token;
    const abort = new AbortController();
    const signal = AbortSignal.any([this.accountSignal, abort.signal]);
    const recovery = (async () => {
      while (current() && !signal.aborted) {
        const snapshot = deserializeThreadSnapshot(
          await this.getThreadSnapshotFn({ data: { threadId }, signal }),
        );
        if (signal.aborted || !current()) return;
        if (snapshot.thread.id !== threadId || snapshot.thread.userId !== this.accountId) {
          await waitForSnapshotRetry(signal);
          continue;
        }
        if (
          this.actions.applyThreadSnapshot(
            snapshot.thread,
            snapshot.turns,
            toThreadSnapshotApplyOptions(snapshot),
          )
        ) {
          this.mergeSnapshot(follow, snapshot);
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
}
