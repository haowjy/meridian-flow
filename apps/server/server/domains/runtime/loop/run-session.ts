/** One process-local owner for prepared runs, cancellation, and terminal cleanup. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { type TurnRepository, TurnStartConflictError } from "../../threads/index.js";
import { processDetachedWork } from "../detached-work.js";
import { type CurrentTurn, DEFAULT_LEASE_TTL_MS, type Lease, type RunClaim } from "./ports.js";
import { createRunStarter } from "./run-starter.js";
import {
  NoPendingWakeError,
  type PreparedLoop,
  type PreparedRun,
  type RunLoopInput,
  type RunOutcome,
  type RunTurnInput,
  UnsettledPlaceholderError,
} from "./run-turn-port.js";
import type { RuntimeDelivery } from "./runtime-delivery.js";
import { createWakeIfRunnable } from "./wake-if-runnable.js";

type RunSession = {
  controller: AbortController;
  currentTurn: CurrentTurn | null;
  startedAt: Date;
  child?: RunTurnInput["child"];
  completion: Promise<void>;
};

export function createRunSessions(deps: {
  backgroundTasks?: import("../detached-work.js").DetachedWorkTracker;
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
    "repairOrphanedTurns" | "refreshPending" | "selectPending" | "readRunReceiptIds"
  >;
  handoffBriefs: import("../ports/handoff-briefs.js").HandoffBriefStopper;
  repos: { turns: TurnRepository };
  headSeq(threadId: ThreadId): Promise<bigint>;
  eventSink: EventSink;
  onRunStarted?: (threadId: ThreadId) => void;
  onRunSettled?: (threadId: ThreadId) => void;
}) {
  const running = new Map<ThreadId, RunSession>();
  const backgroundTasks = deps.backgroundTasks ?? processDetachedWork;
  const authority = deps.runClaim;
  const runStarter = createRunStarter({ startDrain }, deps.eventSink);
  const wakeIfRunnable = createWakeIfRunnable({ delivery: deps.delivery, runStarter });
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
    let skipCleanupWake = false;
    const unacknowledgedReceiptIds = new Set<string>();
    async function retainReceiptIds(heldLease: Lease): Promise<boolean> {
      try {
        const ids = await deps.delivery.readRunReceiptIds(heldLease);
        for (const id of ids) unacknowledgedReceiptIds.add(id);
        return true;
      } catch (error) {
        observe(threadId, "receipt_read.failed", error);
        return false;
      }
    }
    async function retainFailedReceipt(heldLease: Lease, userTurnId: string): Promise<boolean> {
      // The failed input can remain pending after its durable lease receipt clears.
      unacknowledgedReceiptIds.add(userTurnId);
      return retainReceiptIds(heldLease);
    }
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
          wakeAfterRelease = (preparedRun || setupMayWake) && !skipCleanupWake;
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
              .then(() => wakeIfRunnable(threadId, [...unacknowledgedReceiptIds]))
              .catch((error) => observe(threadId, "cleanup_wake.failed", error)),
            "run cleanup wake",
          );
        }
      }
    }
    try {
      lease = await authority.startExecution(threadId, crypto.randomUUID());
      if (!lease) throw new TurnStartConflictError(threadId, "already_running");
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
            if (turn.role === "assistant" && turn.status === "error") {
              if (!(await retainFailedReceipt(heldLease, loop.userTurnId))) skipCleanupWake = true;
            }
          } catch (error) {
            observe(threadId, "execution.failed", error);
            if (error instanceof UnsettledPlaceholderError) {
              if (!(await retainFailedReceipt(heldLease, loop.userTurnId))) skipCleanupWake = true;
              throw error;
            }
            if (session.currentTurn?.kind === "assistant") {
              if (!(await retainFailedReceipt(heldLease, loop.userTurnId))) skipCleanupWake = true;
            }
            turn = await deps.finalizeFailure({
              threadId,
              turnId: session.currentTurn?.id ?? loop.currentTurn?.id ?? loop.terminalTurnId!,
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
        executionTurnId: loop.currentTurn?.id ?? loop.terminalTurnId!,
        resumeAfterSeq,
        snapshotFloorNextSeq,
        execute: () => (execution ??= execute()),
      };
    } catch (error) {
      setupMayWake = error instanceof NoPendingWakeError || isAbortError(error);
      if (lease && session.currentTurn) {
        try {
          if (session.currentTurn.kind === "assistant") await retainReceiptIds(lease);
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
      if (!(error instanceof NoPendingWakeError)) throw error;
    }
  }
  return {
    prepare,
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
