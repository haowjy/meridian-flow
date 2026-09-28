/** One process-local owner for prepared runs, cancellation, and terminal cleanup. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import { type TurnRepository, TurnStartConflictError } from "../../threads/index.js";
import { planControlBarrier } from "./control-barrier.js";
import { type CurrentTurn, DEFAULT_LEASE_TTL_MS, type Lease, type RunClaim } from "./ports.js";
import { createRunStarter } from "./run-starter.js";
import {
  NoPendingWakeError,
  PendingHandoffSeedError,
  type PreparedLoop,
  type PreparedRun,
  type RunLoopInput,
  type RunOutcome,
  type RunTurnInput,
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
    let restartPendingAfterCompletion = false;
    let preparedRun = false;
    let handoffGatedStart = false;
    async function cleanup(restartPending = false, releaseUnanswered = false) {
      clearInterval(heartbeat);
      parentSignal?.removeEventListener("abort", abort);
      running.delete(threadId);
      // A child invocation bounds its whole subtree; a primary may detach background children.
      abortChildrenOf(threadId, !!input.child);
      try {
        if (lease) await authority.release(lease);
        if (lease) {
          await deps.delivery.refreshPending(threadId);
          const pending = await deps.delivery.selectPending(threadId);
          const runnableInput =
            planControlBarrier({ pending, chainedIds: new Set(), boundIds: new Set() }).execute !==
              null || pending.some((message) => message.intent === "message");
          const seedSettled = !(await deps.repos.turns.hasPendingHandoffSeed(threadId));
          if (
            (preparedRun &&
              (planControlBarrier({ pending, chainedIds: new Set(), boundIds: new Set() }).execute !==
                null ||
                ((releaseUnanswered || (restartPending && !session.controller.signal.aborted)) &&
                  pending.some((message) => message.intent === "message")))) ||
            (handoffGatedStart && seedSettled && runnableInput)
          ) {
            restartPendingAfterCompletion = true;
          }
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
        if (restartPendingAfterCompletion) {
          void session.completion
            .then(() => createRunStarter({ startDrain }, deps.eventSink).start(threadId))
            .catch((error) => observe(threadId, "cleanup_wake.failed", error));
        }
      }
    }
    try {
      lease = await authority.startExecution(threadId, crypto.randomUUID());
      if (!lease) throw new TurnStartConflictError(threadId, "already_running");
      const heldLease = lease;
      heartbeat = setInterval(
        () => {
          void authority
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
            .catch((error) => observe(threadId, "lease_renew.failed", error));
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
          } catch (error) {
            observe(threadId, "execution.failed", error);
            if (error instanceof UnsettledPlaceholderError) throw error;
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
        await cleanup(
          outcome.status === "complete",
          outcome.status !== "failed" &&
            ((outcome.turn.metadata as import("@meridian/contracts/threads").JsonObject | null)
              ?.kind === "compaction_undo" ||
              (outcome.turn.role === "compaction" &&
                (outcome.turn.metadata as import("@meridian/contracts/threads").JsonObject | null)
                  ?.trigger === "manual")),
        );
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
      handoffGatedStart = error instanceof PendingHandoffSeedError;
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
    if (await deps.repos.turns.hasPendingHandoffSeed(threadId)) return;
    try {
      const run = await prepare({ threadId, drain: true });
      void run.execute();
    } catch (error) {
      if (!(error instanceof NoPendingWakeError || error instanceof PendingHandoffSeedError)) throw error;
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
        void active.completion
          .then(() => createRunStarter({ startDrain }, deps.eventSink).start(threadId))
          .catch((error) => observe(threadId, "cancel_wake.failed", error));
      }
      return "cancelled";
    },
  };
}

export type TurnRunner = ReturnType<typeof createRunSessions>;
export type RunningTurnView = NonNullable<ReturnType<TurnRunner["getRunningTurn"]>>;
