/** One process-local owner for prepared runs, cancellation, and terminal cleanup. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import {
  isWriteModeSwitchTurn,
  type ThreadRepository,
  type TurnRepository,
  TurnStartConflictError,
} from "../../threads/index.js";
import type { DetachedWorkTracker } from "../detached-work.js";
import { createLocalTurn } from "./local-turn.js";
import { queuedWriteModeSwitch } from "./next-inbox-work.js";
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
  startedAt: Date;
  child?: RunTurnInput["child"];
  completion: Promise<void>;
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
    | "refreshPending"
    | "selectPending"
    | "applyDueSwitches"
  >;
  handoffBriefs: import("../ports/handoff-briefs.js").HandoffBriefStopper;
  repos: { turns: TurnRepository; threads: Pick<ThreadRepository, "findById"> };
  headSeq(threadId: ThreadId): Promise<bigint>;
  eventSink: EventSink;
  wakeIfRunnable(threadId: ThreadId): Promise<void>;
  onRunStarted?: (threadId: ThreadId) => void;
  onRunSettled?: (threadId: ThreadId) => void;
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
  function abortChildrenOf(parentThreadId: ThreadId, includeBackground = false) {
    for (const [id, session] of running) {
      if (session.child?.parentThreadId !== parentThreadId) continue;
      if (session.child.background && !includeBackground) continue;
      abortChildrenOf(id, includeBackground);
      session.controller.abort();
    }
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
    async function cleanup() {
      clearInterval(heartbeat);
      parentSignal?.removeEventListener("abort", abort);
      running.delete(threadId);
      // A child invocation bounds its whole subtree; a primary may detach background children.
      abortChildrenOf(threadId, !!input.child);
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
      if (
        "expectedLeafTurnId" in input &&
        input.expectedLeafTurnId &&
        (await deps.repos.turns.getLatestByThread(threadId))?.id !== input.expectedLeafTurnId
      )
        throw new ReplyRetryUnavailableError(threadId);
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
      }
      await cleanup();
      throw error;
    }
  }

  /** A switch applied after a failed reply must not take Retry away; the retry chains after it. */
  async function pastTrailingSwitches(turn: Turn): Promise<Turn | null> {
    let current: Turn | null = turn;
    while (current && isWriteModeSwitchTurn(current) && current.prevTurnId)
      current = await deps.repos.turns.findById(current.prevTurnId as TurnId);
    return current;
  }

  async function startDrain(threadId: ThreadId): Promise<void> {
    try {
      const run = await prepare({ threadId, drain: true });
      backgroundTasks.track(run.execute(), "detached run execution");
    } catch (error) {
      if (!(error instanceof NoPendingWakeError) && !(error instanceof RuntimeShuttingDownError))
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
      if (replay) return replay;
      // A refusal can rest on reads that raced this request's own reservation
      // elsewhere; that reservation commits with the leaf it moves, so a later
      // acceptance read sees it. Another tab's request id never matches.
      // Shutdown refuses too, but only new work: never an accepted request.
      const refuse = async (refusal: Error = new ReplyRetryUnavailableError(input.threadId)) => {
        const raced = await accepted();
        if (raced) return raced;
        throw refusal;
      };

      const [failedTurn, latestTurn, runState] = await Promise.all([
        deps.repos.turns.findById(input.failedTurnId),
        deps.repos.turns.getLatestByThread(input.threadId),
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
        (await pastTrailingSwitches(latestTurn))?.id !== failedTurn.id
      )
        return refuse();

      // A Retry starts a reply, so a pending switch applies first and the retry chains after it.
      let leafTurn = latestTurn;
      if (queuedWriteModeSwitch(await deps.delivery.selectPending(input.threadId))) {
        if (!(await deps.delivery.applyDueSwitches(input.threadId, true)))
          throw new ReplyRetryPendingError(input.threadId);
        leafTurn = (await deps.repos.turns.getLatestByThread(input.threadId)) ?? latestTurn;
      }

      let run: PreparedRun;
      try {
        run = await prepare({
          threadId: input.threadId,
          drain: true,
          replyTurnId: input.replyTurnId,
          retryOf: input.failedTurnId,
          expectedLeafTurnId: leafTurn.id,
        });
      } catch (error) {
        const raced = await accepted();
        if (raced) return raced;
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
            prevTurnId: firstTurn?.role === "compaction" ? firstTurn.id : leafTurn.id,
            position:
              (firstTurn?.role === "compaction" ? firstTurn.position : leafTurn.position) + 1,
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
      return { created: true as const, turn, executionId: run.executionId };
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
    async cancel(
      threadId: ThreadId,
      turnId: TurnId,
    ): Promise<"cancelled" | "already_finished" | "not_found"> {
      const active = running.get(threadId);
      const turn = await deps.repos.turns.findById(turnId);
      if (!turn || turn.threadId !== threadId) return "not_found";
      if (await deps.handoffBriefs.stop(threadId, turnId)) return "cancelled";
      if (!(await authority.cancelExecution(threadId, turnId)))
        return isTerminalTurnStatus(turn.status) || active ? "already_finished" : "not_found";
      if (active) {
        abortChildrenOf(threadId, true);
        active.controller.abort();
      }
      return "cancelled";
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export type TurnRunner = ReturnType<typeof createRunSessions>;
export type RunningTurnView = NonNullable<ReturnType<TurnRunner["getRunningTurn"]>>;
