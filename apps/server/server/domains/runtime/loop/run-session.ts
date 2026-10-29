/** One process-local owner for prepared runs, cancellation, and terminal cleanup. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import {
  type HandBackRequest,
  isTerminalTurnStatus,
  type SendNowRequest,
  type SendNowResponse,
  type StopRequest,
  type StopResponse,
  type Turn,
} from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import {
  type ThreadRepository,
  type TurnRepository,
  TurnStartConflictError,
} from "../../threads/index.js";
import { turnGraph } from "../../threads/ports/turn-graph.js";
import type { DetachedWorkTracker } from "../detached-work.js";
import type { HandoffBriefStopper } from "../ports/handoff-briefs.js";
import { latestRowAt } from "./latest-row.js";
import { createLocalTurn } from "./local-turn.js";
import { type CurrentTurn, DEFAULT_LEASE_TTL_MS, type Lease, type RunClaim } from "./ports.js";
import {
  NoPendingWakeError,
  type PreparedLoop,
  type PreparedRun,
  ReplyRetryPendingError,
  ReplyRetryUnavailableError,
  type RunLoopInput,
  type RunOutcome,
  type RunTurnInput,
  RuntimeShuttingDownError,
  UnsettledPlaceholderError,
} from "./run-turn-port.js";
import type { RuntimeDelivery } from "./runtime-delivery.js";

type RunSession = {
  controller: AbortController;
  currentTurn: CurrentTurn | null;
  /** The execution this session holds, once it has the lease. */
  executionId: string | null;
  startedAt: Date;
  child?: RunTurnInput["child"];
  completion: Promise<void>;
};

/**
 * What a lineage cancellation reaches below its owner. `chat` (Stop): the whole subtree.
 * `turn`: the subtrees that turn's execution spawned, and the turn's own question.
 * `terminal`: a child run that ended takes its whole subtree.
 * `deleted` (trash, Work delete): the whole subtree and everything the owner holds.
 */
export type LineageReach =
  | { kind: "chat" }
  | { kind: "turn"; turnId: TurnId }
  | { kind: "terminal" }
  | { kind: "deleted" };

/**
 * The owner's own decision, made under its thread lock inside the command's transaction:
 * how far the cancellation reaches (none, when the decision cancels nothing), and the
 * owner's execution it cancelled.
 */
export type LineageDecision<T> = {
  result: T;
  reach: LineageReach | null;
  execution: string | null;
};

export type LineageCancelled<T> = {
  result: T;
  /** The owner's execution the decision cancelled. */
  execution: string | null;
  /** Subagent threads cancelled, parents first; never the owner. */
  targets: ThreadId[];
};

/** Lineage cancellation, one durable command (`spawn/lineage-cancellation.ts`). */
export type LineageCancellation = {
  /** Joins the caller's transaction when there is one. */
  cancel<T>(
    threadId: ThreadId,
    decide: () => Promise<LineageDecision<T>>,
  ): Promise<LineageCancelled<T>>;
  /** A child run that ended (`terminal`): free when it has no subtree, as most don't. */
  endSubtree(threadId: ThreadId): Promise<ThreadId[]>;
};

/** Child invocation cards: every run publishes its saved report when it ends. */
export type RunSessionReports = {
  publish(threadId: ThreadId, executionTurnId: TurnId): Promise<unknown>;
};

export function createRunSessions(deps: {
  shutdown: { started: boolean };
  backgroundTasks: DetachedWorkTracker;
  setup(input: RunLoopInput): Promise<PreparedLoop>;
  finalizeFailure(input: {
    threadId: ThreadId;
    turnId: TurnId;
    error: unknown;
    signal: AbortSignal;
    lease: Lease;
  }): Promise<Turn>;
  runClaim: RunClaim;
  delivery: Pick<
    RuntimeDelivery,
    | "settleStaleExecution"
    | "releaseExecution"
    | "selectPending"
    | "answerRunState"
    | "stop"
    | "handBack"
    | "sendNow"
  >;
  handoffBriefs: HandoffBriefStopper;
  repos: {
    turns: TurnRepository;
    threads: Pick<ThreadRepository, "findById" | "listSubtreeIds">;
  };
  headSeq(threadId: ThreadId): Promise<bigint>;
  eventSink: EventSink;
  wakeIfRunnable(threadId: ThreadId): Promise<void>;
  onRunStarted?: (threadId: ThreadId) => void;
  onRunSettled?: (threadId: ThreadId) => void;
  lineage: LineageCancellation;
  reports: RunSessionReports;
  /** Runs after the ambient transaction commits, or at once outside one. */
  afterCommit(task: () => void): void;
}) {
  const running = new Map<ThreadId, RunSession>();
  const shutdown = deps.shutdown;
  const backgroundTasks = deps.backgroundTasks;
  const authority = deps.runClaim;
  function observe(threadId: ThreadId, name: string, error: unknown) {
    emitEvent(deps.eventSink, {
      level: "error",
      source: "runtime.run-session",
      name,
      correlation: { threadId },
      payload: unknownToEventPayload(error),
    });
  }
  /** A root run's foreground children, which die with the call that drives them. */
  function abortChildrenOf(parentThreadId: ThreadId) {
    for (const [id, session] of running) {
      if (session.child?.parentThreadId !== parentThreadId || session.child.background) continue;
      abortChildrenOf(id);
      session.controller.abort();
    }
  }

  /**
   * This session, when it holds the execution a command's durable answer cancelled (Stop, Send
   * now, turn cancel). A replayed answer names an execution that may be long over, so it never
   * matches a newer one.
   */
  function confirmedSession(threadId: ThreadId, cancelledExecutionId: string | null) {
    const active = running.get(threadId);
    return active && cancelledExecutionId !== null && cancelledExecutionId === active.executionId
      ? active
      : null;
  }

  /**
   * Ends a lineage through the one durable command, then aborts this process's runs it reached:
   * the owner's execution the decision cancelled, and every target. The aborts only make them stop
   * sooner; the committed flags stop runs in any process at their next heartbeat, and nothing a
   * cancelled run writes afterwards wakes a parent.
   */
  async function cancelLineage<T>(
    threadId: ThreadId,
    decide: () => Promise<LineageDecision<T>>,
  ): Promise<T> {
    const ended = await deps.lineage.cancel(threadId, decide);
    deps.afterCommit(() => {
      confirmedSession(threadId, ended.execution)?.controller.abort();
      abortAll(ended.targets);
    });
    return ended.result;
  }

  function abortAll(threadIds: readonly ThreadId[]) {
    for (const id of threadIds) running.get(id)?.controller.abort();
  }

  async function prepare(input: RunTurnInput): Promise<PreparedRun> {
    const { threadId } = input;
    if (shutdown.started) throw new RuntimeShuttingDownError(threadId);
    if (running.has(threadId)) throw new TurnStartConflictError(threadId, "already_running");
    const controller = new AbortController();
    let complete!: () => void;
    const session: RunSession = {
      controller,
      currentTurn: null,
      executionId: null,
      startedAt: new Date(),
      child: input.child,
      completion: new Promise<void>((resolve) => {
        complete = resolve;
      }),
    };
    running.set(threadId, session);
    const abort = () => controller.abort();
    const parentSignal = input.child?.background ? undefined : input.signal;
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener("abort", abort, { once: true });
    let lease: Lease | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let preparedRun = false;
    let setupMayWake = false;
    // Holding its claim, a terminal child ends its subtree before anything can wake it.
    const cancelOwnLineage = () =>
      deps.lineage
        .endSubtree(threadId)
        .then(abortAll)
        .catch((error) => observe(threadId, "lineage.cancel_failed", error));
    async function cleanup() {
      clearInterval(heartbeat);
      parentSignal?.removeEventListener("abort", abort);
      running.delete(threadId);
      // A child's subtree is ended by lineage cancellation before cleanup; a root
      // run's background children outlive it.
      if (!input.child) abortChildrenOf(threadId);
      let claimReleased = !lease;
      let wakeAfterRelease = false;
      try {
        if (lease) {
          // Ends the execution when its turns are terminal, else abandons it to
          // the next claim holder's settlement; either way the claim unlocks.
          await deps.delivery.releaseExecution(lease);
          claimReleased = true;
          wakeAfterRelease =
            preparedRun || setupMayWake || ("replyTurnId" in input && !!input.replyTurnId);
        }
      } catch (error) {
        observe(threadId, "lease_release.failed", error);
      } finally {
        complete();
        try {
          if (preparedRun) deps.onRunSettled?.(threadId);
        } catch (error) {
          observe(threadId, "settled.failed", error);
        }
        if (claimReleased && wakeAfterRelease) {
          backgroundTasks.track(
            session.completion
              .then(() => deps.wakeIfRunnable(threadId))
              .catch((error) => observe(threadId, "cleanup_wake.failed", error)),
            "run cleanup wake",
          );
        }
      }
    }
    try {
      lease = await authority.startExecution(threadId, crypto.randomUUID(), () =>
        deps.delivery.settleStaleExecution(threadId),
      );
      if (!lease) throw new TurnStartConflictError(threadId, "already_running");
      if (shutdown.started) throw new RuntimeShuttingDownError(threadId);
      const heldLease = lease;
      session.executionId = heldLease.executionId;
      heartbeat = setInterval(
        () => {
          backgroundTasks.track(
            authority
              .renew(heldLease)
              .then(async (held) => {
                if (!held) {
                  clearInterval(heartbeat);
                  observe(threadId, "lease.lost", new Error("Run lease lost"));
                  controller.abort();
                } else {
                  const state = await authority.read(threadId);
                  if (state.kind === "awake" && state.cancelRequested) controller.abort();
                }
              })
              .catch((error) => observe(threadId, "lease_renew.failed", error)),
            "run lease renewal",
          );
        },
        Math.floor(DEFAULT_LEASE_TTL_MS / 3),
      );
      heartbeat.unref();
      const resumeAfterSeq = (await deps.headSeq(threadId)).toString();
      const loop = await deps.setup({
        ...input,
        signal: controller.signal,
        lease,
        onCurrentTurnChanged(turn) {
          session.currentTurn = turn;
          input.onCurrentTurnChanged?.(turn);
        },
      });
      session.currentTurn = loop.currentTurn;
      const executionTurnId = loop.currentTurn.id;
      if (shutdown.started) throw new RuntimeShuttingDownError(threadId);
      preparedRun = true;
      const snapshotFloorNextSeq = ((await deps.headSeq(threadId)) + 1n).toString();
      try {
        deps.onRunStarted?.(threadId);
      } catch (error) {
        observe(threadId, "started.failed", error);
      }
      let execution: Promise<RunOutcome> | undefined;
      async function execute(): Promise<RunOutcome> {
        let outcome: RunOutcome;
        try {
          let turn: Turn;
          try {
            turn = await loop.execute();
          } catch (error) {
            observe(threadId, "execution.failed", error);
            if (error instanceof UnsettledPlaceholderError) {
              throw error;
            }
            turn = await deps.finalizeFailure({
              threadId,
              turnId: session.currentTurn?.id ?? loop.currentTurn.id,
              error,
              signal: controller.signal,
              lease: heldLease,
            });
          }
          outcome = { status: turn.status as "complete" | "cancelled" | "error", turn };
        } catch (error) {
          observe(threadId, "terminal_fallback.failed", error);
          outcome = { status: "failed", error };
        }
        // Every run publishes its own report; the sweep only repairs a failure here.
        await deps.reports
          .publish(threadId, executionTurnId)
          .catch((error) => observe(threadId, "report.publish_failed", error));
        if (input.child) await cancelOwnLineage();
        await cleanup();
        return outcome;
      }
      return {
        executionId: lease.executionId,
        userTurnId: loop.userTurnId,
        executionTurnId: loop.currentTurn.id,
        resumeAfterSeq,
        snapshotFloorNextSeq,
        execute: () => (execution ??= execute()),
      };
    } catch (error) {
      setupMayWake = error instanceof NoPendingWakeError || isAbortError(error);
      if (lease && session.currentTurn) {
        try {
          await deps.finalizeFailure({
            threadId,
            turnId: session.currentTurn.id,
            error,
            signal: controller.signal,
            lease,
          });
        } catch (failure) {
          observe(threadId, "terminal_fallback.failed", failure);
        }
        if (input.child) await cancelOwnLineage();
      }
      await cleanup();
      throw error;
    }
  }

  async function startDrain(threadId: ThreadId): Promise<void> {
    try {
      const run = await prepare({ threadId, drain: true });
      backgroundTasks.track(run.execute(), "detached run execution");
    } catch (error) {
      // A lineage cancel aborts a target's wake that a cancelled run's notice started.
      if (
        !(error instanceof NoPendingWakeError) &&
        !(error instanceof RuntimeShuttingDownError) &&
        !isAbortError(error)
      )
        throw error;
    }
  }
  return {
    prepare,
    /**
     * Retry a latest failed reply under the client-minted `replyTurnId`. A
     * replay is answered from durable facts: the reply by id, else the first
     * turn that request's execution reserved (`metadata.retryReplyId`), which
     * may be a start-time compaction. While the claim is held by an execution
     * that has reserved nothing, a replay can't tell whose it is:
     * `retry_pending`.
     */
    async retryReply(input: { threadId: ThreadId; failedTurnId: TurnId; replyTurnId: TurnId }) {
      // Every answer carries the record read at answer time, under the thread lock.
      const answered = async <T extends object>(result: T) => ({
        ...result,
        runState: await deps.delivery.answerRunState(input.threadId),
      });
      const accepted = async () => {
        const existing = await deps.repos.turns.findById(input.replyTurnId);
        if (existing) {
          if (existing.threadId !== input.threadId || existing.role !== "assistant")
            throw new ReplyRetryUnavailableError(input.threadId);
          return { created: false as const, turn: existing, executionId: existing.executionId };
        }
        // Matched by request id: another tab's Retry of the same reply is not this one.
        const retrying = await deps.repos.turns.findRetryReservation(
          input.threadId,
          input.replyTurnId,
        );
        return retrying
          ? { created: false as const, turn: null, executionId: retrying.executionId }
          : null;
      };
      const replay = await accepted();
      if (replay) return answered(replay);
      // A refusal can rest on reads that raced this request's own reservation
      // elsewhere; that reservation commits with the leaf it moves, so a later
      // acceptance read sees it. Another tab's request id never matches.
      // Shutdown refuses too, but only new work: never an accepted request.
      const refuse = async (refusal: Error = new ReplyRetryUnavailableError(input.threadId)) => {
        const raced = await accepted();
        if (raced) return answered(raced);
        throw refusal;
      };

      const [failedTurn, leafThread, latestTurn, runState] = await Promise.all([
        deps.repos.turns.findById(input.failedTurnId),
        deps.repos.threads.findById(input.threadId),
        turnGraph(deps.repos.turns).latest(input.threadId),
        authority.read(input.threadId),
      ]);
      if (shutdown.started) return refuse(new RuntimeShuttingDownError(input.threadId));
      if (running.has(input.threadId) || runState.kind === "awake") {
        if ((await authority.readOpenExecutionId(input.threadId)) === null)
          throw new ReplyRetryPendingError(input.threadId);
        // The holder reserved: it is this request's only if it recorded its id.
        return refuse();
      }
      if (
        !failedTurn ||
        failedTurn.threadId !== input.threadId ||
        failedTurn.role !== "assistant" ||
        failedTurn.status !== "error" ||
        !latestTurn ||
        (await latestRowAt(deps.repos.turns, leafThread?.activeLeafTurnId ?? null)).latest?.id !==
          failedTurn.id
      )
        return refuse();

      let run: PreparedRun;
      try {
        run = await prepare({
          threadId: input.threadId,
          drain: true,
          replyTurnId: input.replyTurnId,
          retryOf: input.failedTurnId,
        });
      } catch (error) {
        const raced = await accepted();
        if (raced) return answered(raced);
        // Another holder took the claim before its lease row was visible.
        if (error instanceof TurnStartConflictError)
          throw new ReplyRetryPendingError(input.threadId);
        if (error instanceof NoPendingWakeError)
          throw new ReplyRetryUnavailableError(input.threadId);
        throw error;
      }
      // This call owns the prepared execution: it runs before any read that
      // only describes the answer, so a failing read can't strand it. The
      // execution is the answer; the reply is best-effort decoration.
      backgroundTasks.track(run.execute(), "detached reply retry");
      const describe = async (prepared: PreparedRun): Promise<Turn> => {
        const [persisted, firstTurn, thread] = await Promise.all([
          deps.repos.turns.findById(input.replyTurnId),
          deps.repos.turns.findById(prepared.executionTurnId),
          // A Retry is a new reply, so it runs in the chat's current mode (D62).
          deps.repos.threads.findById(input.threadId),
        ]);
        return (
          persisted ??
          createLocalTurn({
            id: input.replyTurnId,
            threadId: input.threadId,
            prevTurnId: firstTurn?.role === "compaction" ? firstTurn.id : latestTurn.id,
            position:
              (firstTurn?.role === "compaction" ? firstTurn.position : latestTurn.position) + 1,
            role: "assistant",
            origin: "assistant",
            status: "pending",
            writeMode: thread?.aiWriteMode,
            executionId: prepared.executionId,
          })
        );
      };
      const turn = await describe(run).catch((error: unknown) => {
        observe(input.threadId, "retry.describe_failed", error);
        return null;
      });
      return answered({ created: true as const, turn, executionId: run.executionId });
    },
    startDrain,
    getRunningTurn(threadId: ThreadId) {
      const session = running.get(threadId);
      return session
        ? {
            turnId: session.currentTurn?.id ?? null,
            kind: session.currentTurn?.kind ?? null,
            startedAt: session.startedAt,
          }
        : null;
    },
    getRunningTurnId: (threadId: ThreadId) => running.get(threadId)?.currentTurn?.id ?? null,
    isThreadRunning: (threadId: ThreadId) => running.has(threadId),
    beginShutdown() {
      shutdown.started = true;
      for (const session of running.values()) session.controller.abort("shutdown");
    },
    /**
     * Chat Stop: the delivery decides and flags under the thread lock; this session then aborts its
     * own run at once when it holds the flagged execution (any other holder sees the flag at its next
     * check). A replayed press names an execution that may be long over, so it never aborts a newer one.
     */
    stop: (threadId: ThreadId, request: StopRequest): Promise<StopResponse> =>
      cancelLineage(threadId, async () => {
        const response = await deps.delivery.stop(threadId, request);
        // Stop is "stop everything": the whole subtree, whichever turn spawned it.
        return {
          result: response,
          reach: { kind: "chat" },
          execution: response.cancelledExecutionId,
        };
      }),
    /** The queue's x and Cancel queue: decided under the thread lock; never cancels a reply. */
    handBack: (threadId: ThreadId, request: HandBackRequest) =>
      deps.delivery.handBack(threadId, request),
    /** Send now: as Stop aborts the run it flagged, and nothing is handed back. */
    sendNow: (threadId: ThreadId, request: SendNowRequest): Promise<SendNowResponse> =>
      cancelLineage(threadId, async () => {
        const response = await deps.delivery.sendNow(threadId, request);
        const execution = response.cancelledExecutionId;
        // Like cancelling that turn: it ends what the reply spawned, nothing older. Before its
        // first turn the execution has spawned and relayed nothing.
        const turnId = execution ? await authority.readRunningTurnId(threadId) : null;
        return {
          result: response,
          reach: turnId ? { kind: "turn", turnId } : null,
          execution,
        };
      }),
    /**
     * Cancels a turn: its live execution, or the question it is parked on, and the subagents
     * that turn's execution spawned.
     */
    async cancel(
      threadId: ThreadId,
      turnId: TurnId,
    ): Promise<"cancelled" | "already_finished" | "not_found"> {
      const turn = await deps.repos.turns.findById(turnId);
      if (!turn || turn.threadId !== threadId) return "not_found";
      if (await deps.handoffBriefs.stop(threadId, turnId)) return "cancelled";
      return cancelLineage(threadId, async () => {
        const live = await authority.cancelExecution(threadId, turnId);
        const current = live ? turn : await deps.repos.turns.findById(turnId);
        if (!live && current?.status !== "awaiting_answer")
          return {
            result:
              (current && isTerminalTurnStatus(current.status)) || running.has(threadId)
                ? ("already_finished" as const)
                : ("not_found" as const),
            reach: null,
            execution: null,
          };
        return {
          result: "cancelled" as const,
          reach: { kind: "turn", turnId },
          execution: live ? turn.executionId : null,
        };
      });
    },
    /**
     * Ends deleted threads' work inside the caller's transaction: each one's live execution and
     * whole subagent subtree, one lineage per topmost thread (a deleted Work lists its threads'
     * descendants too).
     */
    async stopThreads(threadIds: readonly ThreadId[]): Promise<void> {
      const subtrees = await Promise.all(
        threadIds.map((threadId) => deps.repos.threads.listSubtreeIds(threadId)),
      );
      const covered = new Set(subtrees.flat());
      for (const threadId of [...threadIds].sort()) {
        if (covered.has(threadId)) continue;
        await cancelLineage(threadId, async () => ({
          result: undefined,
          reach: { kind: "deleted" },
          execution: running.get(threadId)?.executionId ?? null,
        }));
      }
    },
  };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export type TurnRunner = ReturnType<typeof createRunSessions>;
export type RunningTurnView = NonNullable<ReturnType<TurnRunner["getRunningTurn"]>>;
