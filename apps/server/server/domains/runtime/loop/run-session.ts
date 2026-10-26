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
 * What a lineage cancellation reaches. `chat` (Stop): the chat's whole subtree.
 * `turn`: only the subtrees that turn's execution spawned. `terminal`: a child
 * run that ended, which takes its whole subtree with it. `execution` is the
 * owner's execution the same command cancelled, if any.
 */
export type LineageScope =
  | { kind: "chat"; threadId: ThreadId; execution: string | null }
  | { kind: "turn"; threadId: ThreadId; turnId: TurnId; execution: string | null }
  | { kind: "terminal"; threadId: ThreadId };

/** The durable steps of lineage cancellation; the run session adds local aborts and waits. */
export type LineageCancellation = {
  /** Subagent threads the scope cancels, parents before children; never the owner. */
  targets(scope: LineageScope): Promise<ThreadId[]>;
  /**
   * Sets the durable cancel flag on each target's live run (heartbeats honour it in any
   * process) and drops the lineage's queued work: agent rows on the targets, their notices
   * to the owner and, for Stop or a cancelled turn, the owner's continuation obligations
   * unless an execution the command spared holds them. Repeatable.
   */
  withdraw(scope: LineageScope, threadIds: readonly ThreadId[]): Promise<void>;
  /** Cancels the scope's open asks, a turn's own last, and finalizes each parked invocation. */
  settle(scope: LineageScope, threadIds: readonly ThreadId[]): Promise<void>;
};

/** Bounds re-aborting targets that a cancelled run's notice woke again. */
const LINEAGE_CANCEL_ROUNDS = 5;
/** Bounds waiting for this process's runs, so a tool that ignores its abort can't hold a cancel. */
const LINEAGE_CANCEL_WAIT_MS = 5_000;

/** Child invocation cards: running at admission, the saved report when the run ends. */
export type RunSessionReports = {
  projectRunning(threadId: ThreadId, executionTurnId: TurnId): Promise<void>;
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
  repos: { turns: TurnRepository; threads: Pick<ThreadRepository, "findById"> };
  headSeq(threadId: ThreadId): Promise<bigint>;
  eventSink: EventSink;
  wakeIfRunnable(threadId: ThreadId): Promise<void>;
  onRunStarted?: (threadId: ThreadId) => void;
  onRunSettled?: (threadId: ThreadId) => void;
  lineage: LineageCancellation;
  reports: RunSessionReports;
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
   * Ends a lineage, and the owner's execution a command cancelled with it. The lineage's
   * queued work is withdrawn before anything is aborted, the owner's continuation included,
   * so no aborted run's cleanup wake finds it. Then the runs are aborted (foreground children
   * follow the owner's signal), this process's targets are awaited, the work they queued
   * meanwhile is withdrawn again, and only then do the asks lift and parked cards settle. A
   * cancelled run's notice can wake another target, so the abort repeats while a target runs
   * here. The wait is bounded; runs in other processes, or past the bound, stop at their next
   * heartbeat, and a notice they publish after the last withdrawal can still wake a parent.
   */
  async function cancelLineage(scope: LineageScope): Promise<void> {
    const lineage = deps.lineage;
    const threads = await lineage.targets(scope);
    await lineage.withdraw(scope, threads);
    if (scope.kind !== "terminal")
      confirmedSession(scope.threadId, scope.execution)?.controller.abort();
    const deadline = Date.now() + LINEAGE_CANCEL_WAIT_MS;
    for (let round = 0; round < LINEAGE_CANCEL_ROUNDS; round += 1) {
      const live = threads.flatMap((id) => {
        const session = running.get(id);
        return session ? [session] : [];
      });
      if (live.length === 0) break;
      for (const session of live) session.controller.abort();
      const settled = await settledBy(
        deadline,
        live.map((session) => session.completion),
      );
      await lineage.withdraw(scope, threads);
      if (!settled) break;
    }
    await lineage.settle(scope, threads);
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
      cancelLineage({ kind: "terminal", threadId }).catch((error) =>
        observe(threadId, "lineage.cancel_failed", error),
      );
    async function cleanup(preserveDescendants = false) {
      clearInterval(heartbeat);
      parentSignal?.removeEventListener("abort", abort);
      running.delete(threadId);
      // A child's subtree is ended by lineage cancellation before cleanup; a root
      // run's background children outlive it, and an asked child is parked.
      if (!preserveDescendants && !input.child) abortChildrenOf(threadId);
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
      // A projection, not an obligation: the terminal publication replaces the card.
      await deps.reports
        .projectRunning(threadId, executionTurnId)
        .catch((error) => observe(threadId, "report.project_running_failed", error));
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
            // A cancelled relay throws its abort; that is the cancellation, not a failure.
            if (!(controller.signal.aborted && isAbortError(error)))
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
        // An asked child is parked, not terminal: its descendants keep running
        // and their notifications remain ordered behind its ask barrier.
        const asked = outcome.status !== "failed" && outcome.turn.status === "awaiting_answer";
        if (input.child && !asked) await cancelOwnLineage();
        await cleanup(asked);
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
    async stop(threadId: ThreadId, request: StopRequest): Promise<StopResponse> {
      const response = await deps.delivery.stop(threadId, request);
      // Stop is "stop everything": the whole subtree, whichever turn spawned it.
      await cancelLineage({ kind: "chat", threadId, execution: response.cancelledExecutionId });
      return response;
    },
    /** The queue's x and Cancel queue: decided under the thread lock; never cancels a reply. */
    handBack: (threadId: ThreadId, request: HandBackRequest) =>
      deps.delivery.handBack(threadId, request),
    /** Send now: as Stop aborts the run it flagged, and nothing is handed back. */
    async sendNow(threadId: ThreadId, request: SendNowRequest): Promise<SendNowResponse> {
      const response = await deps.delivery.sendNow(threadId, request);
      const cancelled = confirmedSession(threadId, response.cancelledExecutionId);
      const turnId = cancelled?.currentTurn?.id;
      // Like cancelling that turn: it ends what the reply spawned, nothing older. Before its
      // first turn the execution has spawned and relayed nothing.
      if (turnId)
        await cancelLineage({
          kind: "turn",
          threadId,
          turnId,
          execution: response.cancelledExecutionId,
        });
      else cancelled?.controller.abort();
      return response;
    },
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
      const live = await authority.cancelExecution(threadId, turnId);
      if (!live && turn.status !== "awaiting_answer")
        return isTerminalTurnStatus(turn.status) || running.has(threadId)
          ? "already_finished"
          : "not_found";
      await cancelLineage({
        kind: "turn",
        threadId,
        turnId,
        execution: live ? turn.executionId : null,
      });
      return "cancelled";
    },
    /**
     * Ends deleted threads' work: each one's live execution and whole subagent subtree,
     * one lineage per topmost thread (a deleted Work lists its threads' descendants too).
     */
    async stopThreads(threadIds: readonly ThreadId[]): Promise<void> {
      const subtrees = await Promise.all(
        threadIds.map((threadId) =>
          deps.lineage.targets({ kind: "chat", threadId, execution: null }),
        ),
      );
      const covered = new Set(subtrees.flat());
      for (const threadId of threadIds) {
        if (covered.has(threadId)) continue;
        const turnId = await authority.readRunningTurnId(threadId);
        const turn = turnId ? await deps.repos.turns.findById(turnId) : null;
        const live = turn ? await authority.cancelExecution(threadId, turn.id) : false;
        await cancelLineage({
          kind: "chat",
          threadId,
          execution: live ? (turn?.executionId ?? null) : null,
        });
      }
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Whether every completion settled before the deadline. */
async function settledBy(deadline: number, completions: readonly Promise<void>[]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([Promise.all(completions).then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export type TurnRunner = ReturnType<typeof createRunSessions>;
export type RunningTurnView = NonNullable<ReturnType<TurnRunner["getRunningTurn"]>>;
