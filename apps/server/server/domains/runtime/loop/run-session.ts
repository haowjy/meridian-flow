/** One process-local owner for prepared runs, cancellation, and terminal cleanup. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { type TurnRepository, TurnStartConflictError } from "../../threads/index.js";
import type { DetachedWorkTracker } from "../detached-work.js";
import { createLocalTurn } from "./local-turn.js";
import { type CurrentTurn, DEFAULT_LEASE_TTL_MS, type Lease, type RunClaim } from "./ports.js";
import { createRunStarter } from "./run-starter.js";
import {
  NoPendingWakeError,
  type PreparedLoop,
  type PreparedRun,
  ReplyRetryUnavailableError,
  type RunLoopInput,
  type RunOutcome,
  type RunTurnInput,
  RuntimeShuttingDownError,
  UnsettledPlaceholderError,
} from "./run-turn-port.js";
import type { RuntimeDelivery } from "./runtime-delivery.js";
import { createWakeIfRunnable } from "./wake-if-runnable.js";

type RunSession = {
  controller: AbortController;
  currentTurn: CurrentTurn | null;
  startedAt: Date;
  promisedSuccessor?: { turnId: TurnId; failedTurnId: TurnId };
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
  delivery: Pick<RuntimeDelivery, "repairOrphanedTurns" | "refreshPending" | "selectPending">;
  handoffBriefs: import("../ports/handoff-briefs.js").HandoffBriefStopper;
  repos: { turns: TurnRepository };
  headSeq(threadId: ThreadId): Promise<bigint>;
  eventSink: EventSink;
  onRunStarted?: (threadId: ThreadId) => void;
  onRunSettled?: (threadId: ThreadId) => void;
}) {
  const running = new Map<ThreadId, RunSession>();
  const shutdown = deps.shutdown;
  const backgroundTasks = deps.backgroundTasks;
  const authority = deps.runClaim;
  const runStarter = createRunStarter({ startDrain }, deps.eventSink);
  const wakeIfRunnable = createWakeIfRunnable({
    delivery: deps.delivery,
    runStarter,
    shutdown,
  });
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
          await authority.release(lease);
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
              .then(() => wakeIfRunnable(threadId))
              .catch((error) => observe(threadId, "cleanup_wake.failed", error)),
            "run cleanup wake",
          );
        }
      }
    }
    try {
      lease = await authority.startExecution(threadId, crypto.randomUUID());
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
      await deps.delivery.repairOrphanedTurns(lease);
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
        runId: lease.runId,
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
    async retryReply(input: { threadId: ThreadId; failedTurnId: TurnId; replyTurnId: TurnId }) {
      const existing = await deps.repos.turns.findById(input.replyTurnId);
      if (existing) {
        if (existing.threadId !== input.threadId || existing.role !== "assistant")
          throw new ReplyRetryUnavailableError(input.threadId);
        return { created: false as const, turn: existing };
      }

      const active = running.get(input.threadId);
      if (active?.promisedSuccessor?.turnId === input.replyTurnId) {
        const [failedTurn, currentTurn] = await Promise.all([
          deps.repos.turns.findById(active.promisedSuccessor.failedTurnId),
          active.currentTurn ? deps.repos.turns.findById(active.currentTurn.id) : null,
        ]);
        if (!failedTurn) throw new ReplyRetryUnavailableError(input.threadId);
        return {
          created: false as const,
          turn: createLocalTurn({
            id: input.replyTurnId,
            threadId: input.threadId,
            prevTurnId: currentTurn?.role === "compaction" ? currentTurn.id : failedTurn.id,
            position:
              (currentTurn?.role === "compaction" ? currentTurn.position : failedTurn.position) + 1,
            role: "assistant",
            origin: "assistant",
            status: "pending",
            writeMode: failedTurn.writeMode ?? undefined,
          }),
        };
      }

      const [failedTurn, latestTurn, runState] = await Promise.all([
        deps.repos.turns.findById(input.failedTurnId),
        deps.repos.turns.getLatestByThread(input.threadId),
        authority.read(input.threadId),
      ]);
      if (shutdown.started) throw new RuntimeShuttingDownError(input.threadId);
      if (
        running.has(input.threadId) ||
        runState.kind === "awake" ||
        !failedTurn ||
        failedTurn.threadId !== input.threadId ||
        failedTurn.role !== "assistant" ||
        failedTurn.status !== "error" ||
        latestTurn?.id !== failedTurn.id
      )
        throw new ReplyRetryUnavailableError(input.threadId);

      try {
        const run = await prepare({
          threadId: input.threadId,
          drain: true,
          replyTurnId: input.replyTurnId,
          expectedLeafTurnId: input.failedTurnId,
        });
        const session = running.get(input.threadId);
        if (session)
          session.promisedSuccessor = {
            turnId: input.replyTurnId,
            failedTurnId: input.failedTurnId,
          };
        const persisted = await deps.repos.turns.findById(input.replyTurnId);
        const firstTurn = await deps.repos.turns.findById(run.executionTurnId);
        const turn =
          persisted ??
          createLocalTurn({
            id: input.replyTurnId,
            threadId: input.threadId,
            prevTurnId: firstTurn?.role === "compaction" ? firstTurn.id : failedTurn.id,
            position:
              (firstTurn?.role === "compaction" ? firstTurn.position : failedTurn.position) + 1,
            role: "assistant",
            origin: "assistant",
            status: "pending",
            writeMode: failedTurn.writeMode ?? undefined,
          });
        backgroundTasks.track(run.execute(), "detached reply retry");
        return { created: true as const, turn };
      } catch (error) {
        const raced = await deps.repos.turns.findById(input.replyTurnId);
        if (raced?.threadId === input.threadId && raced.role === "assistant") {
          return { created: false as const, turn: raced };
        }
        if (error instanceof TurnStartConflictError || error instanceof NoPendingWakeError) {
          throw new ReplyRetryUnavailableError(input.threadId);
        }
        throw error;
      }
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
