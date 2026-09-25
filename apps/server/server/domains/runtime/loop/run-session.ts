/** One process-local owner for prepared runs, cancellation, and terminal cleanup. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus, type Turn } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { WorkContextDelivery } from "../../projects/index.js";
import { type TurnRepository, TurnStartConflictError } from "../../threads/index.js";
import { DEFAULT_LEASE_TTL_MS, type Lease, type RunAuthority } from "./ports.js";
import { createRunStarter } from "./run-starter.js";
import {
  NoPendingWakeError,
  type PreparedLoop,
  type PreparedRun,
  type RunLoopInput,
  type RunOutcome,
  type RunTurnInput,
} from "./run-turn-port.js";

type RunSession = {
  controller: AbortController;
  assistantTurnId: TurnId | null;
  startedAt: Date;
  child?: RunTurnInput["child"];
  completion: Promise<void>;
};

export function createRunSessions(deps: {
  setup(input: RunLoopInput): Promise<PreparedLoop>;
  finalizeFailure(input: {
    threadId: ThreadId;
    assistantTurnId: TurnId;
    error: unknown;
    signal: AbortSignal;
    lease: Lease;
  }): Promise<Turn>;
  runAuthority: RunAuthority;
  repos: { turns: TurnRepository };
  headSeq(threadId: ThreadId): Promise<bigint>;
  workContextDelivery: Pick<WorkContextDelivery, "beforeTurn" | "flushOwned">;
  eventSink: EventSink;
  onRunStarted?: (threadId: ThreadId) => void;
  onRunSettled?: (threadId: ThreadId) => void;
}) {
  const running = new Map<ThreadId, RunSession>();
  const authority = deps.runAuthority;
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
      assistantTurnId: null,
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
    async function cleanup() {
      clearInterval(heartbeat);
      parentSignal?.removeEventListener("abort", abort);
      running.delete(threadId);
      // A child invocation bounds its whole subtree; a primary may detach background children.
      abortChildrenOf(threadId, !!input.child);
      try {
        if (lease && session.assistantTurnId) await deps.workContextDelivery.flushOwned(threadId);
      } catch (error) {
        observe(threadId, "work_flush.failed", error);
      }
      try {
        if (lease) await authority.release(lease);
      } catch (error) {
        observe(threadId, "lease_release.failed", error);
      } finally {
        complete();
        try {
          if (session.assistantTurnId) deps.onRunSettled?.(threadId);
        } catch (error) {
          observe(threadId, "settled.failed", error);
        }
      }
    }
    try {
      lease = await authority.acquire(threadId, crypto.randomUUID());
      if (!lease) throw new TurnStartConflictError(threadId, "already_running");
      const heldLease = lease;
      heartbeat = setInterval(
        () => {
          void authority
            .renew(heldLease)
            .then((held) => {
              if (!held) {
                clearInterval(heartbeat);
                observe(threadId, "lease.lost", new Error("Run lease lost"));
                controller.abort();
              }
            })
            .catch((error) => observe(threadId, "lease_renew.failed", error));
        },
        Math.floor(DEFAULT_LEASE_TTL_MS / 3),
      );
      heartbeat.unref?.();
      const resumeAfterSeq = (await deps.headSeq(threadId)).toString();
      await deps.workContextDelivery.beforeTurn(threadId);
      const loop = await deps.setup({
        ...input,
        signal: controller.signal,
        lease,
        onAssistantTurnChanged(turnId) {
          session.assistantTurnId = turnId;
          input.onAssistantTurnChanged?.(turnId);
        },
      });
      session.assistantTurnId = loop.assistantTurnId;
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
            turn = await deps.finalizeFailure({
              threadId,
              assistantTurnId: session.assistantTurnId ?? loop.assistantTurnId,
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
        assistantTurnId: loop.assistantTurnId,
        resumeAfterSeq,
        snapshotFloorNextSeq,
        execute: () => (execution ??= execute()),
      };
    } catch (error) {
      if (lease && session.assistantTurnId) {
        try {
          await deps.finalizeFailure({
            threadId,
            assistantTurnId: session.assistantTurnId,
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
      void run.execute();
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
        ? { assistantTurnId: session.assistantTurnId, startedAt: session.startedAt }
        : null;
    },
    getRunningTurnId: (threadId: ThreadId) => running.get(threadId)?.assistantTurnId ?? null,
    isThreadRunning: (threadId: ThreadId) => running.has(threadId),
    async cancel(
      threadId: ThreadId,
      turnId: TurnId,
    ): Promise<"cancelled" | "already_finished" | "not_found"> {
      const active = running.get(threadId);
      if (active?.assistantTurnId === turnId) {
        if (!(await authority.cancel(threadId, turnId))) return "already_finished";
        abortChildrenOf(threadId, true);
        active.controller.abort();
        void active.completion
          .then(() => createRunStarter({ startDrain }, deps.eventSink).start(threadId))
          .catch((error) => observe(threadId, "cancel_wake.failed", error));
        return "cancelled";
      }
      const turn = await deps.repos.turns.findById(turnId);
      if (!turn || turn.threadId !== threadId) return "not_found";
      if (isTerminalTurnStatus(turn.status) || active) return "already_finished";
      return (await authority.cancel(threadId, turnId)) ? "cancelled" : "not_found";
    },
  };
}

export type TurnRunner = ReturnType<typeof createRunSessions>;
export type RunningTurnView = NonNullable<ReturnType<TurnRunner["getRunningTurn"]>>;
