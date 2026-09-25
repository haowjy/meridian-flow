/**
 * Turn runner: tracks in-flight turns and their AbortControllers so a turn
 * can be started, looked up, and cancelled. Owns the live-turn registry
 * layered over the orchestrator; depends on the orchestrator and thread
 * event hub.
 *
 * Design:
 *
 * - **One running turn per thread**: the `running` Map (ThreadId →
 *   RunningTurn) enforces mutual exclusion. `startDrain` rejects if a turn
 *   is already active for that thread. Writer sends no longer start a turn;
 *   the writer producer persists at enqueue and wakes a drain start.
 *
 * - **Background generator drive**: the orchestrator returns an
 *   `AsyncGenerator<OrchestratorEvent>` that is consumed in the background
 *   (fire-and-forget `void (async () => {...})()` ). Events are written to
 *   the hub by the orchestrator's `emit()` / `persistAndAppendEvents()`;
 *   the turn-runner just drives the generator to completion.
 *
 * - **Cursor capture before start**: `headSeq` is read *before*
 *   `orchestrator.runTurn()` so the client's catchup window includes the
 *   `RUN_STARTED` AG-UI event projected from the assistant turn.created.
 *   If we read after, the client might miss the first event.
 *
 * - **Cancel**: sets the durable lease flag through `RunAuthority.cancel` (the
 *   only cross-process channel) and aborts the local `AbortController` as the
 *   fast path. The orchestrator observes either at its next boundary, finalizes
 *   the turn as cancelled, and releases. Once the run lets go, a pending message
 *   starts the next turn as a drain run; the wake is best-effort and the sweep
 *   is the durable backstop. A cancel for a turn owned by another process only
 *   sets the flag, since no local abort is possible.
 *
 * - **Child runs**: spawn-driven child turns register under their parent so
 *   parent cancel propagates parent→child.
 */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { WorkContextDelivery } from "../../projects/index.js";
import {
  type ThreadEventHub,
  type TurnRepository,
  TurnStartConflictError,
} from "../../threads/index.js";
import type { Lease, RunAuthority } from "./ports.js";
import { createRunStarter } from "./run-starter.js";
import { NoPendingWakeError, type RunTurnInput, type RunTurnPort } from "./run-turn-port.js";

export type TurnRunner = ReturnType<typeof createTurnRunner>;

export interface ChildRunRegistry {
  registerChild(
    parentThreadId: ThreadId,
    childThreadId: ThreadId,
    controller: AbortController,
  ): void;
  registerBackgroundChild(
    parentThreadId: ThreadId,
    childThreadId: ThreadId,
    controller: AbortController,
  ): void;
  unregisterChild(childThreadId: ThreadId): void;
  markChildTurn(childThreadId: ThreadId, assistantTurnId: TurnId): void;
  abortChild(childThreadId: ThreadId): void;
  abortChildrenOf(parentThreadId: ThreadId, options?: { includeBackground?: boolean }): void;
}

type RunningTurn = {
  controller: AbortController;
  assistantTurnId?: TurnId;
  /**
   * Resolves after the background drive clears `running` and releases the lease.
   * Cancel chains the post-interrupt wake on it so the successor drain run starts
   * only once this run no longer holds the thread.
   */
  completion?: Promise<void>;
  /**
   * When ownership of the thread began. The admission producer scopes its
   * setup-window assistant lookup to turns created at or after this instant, so
   * a crash-orphaned non-terminal turn can never be mistaken for this run's.
   */
  startedAt: Date;
};

/** The liveness projection an admission producer may read: never durable status. */
export type RunningTurnView = {
  assistantTurnId: TurnId | null;
  startedAt: Date;
};

type ChildRun = {
  parentThreadId: ThreadId | null;
  controller: AbortController;
  background: boolean;
};

export function createTurnRunner(deps: {
  orchestrator: RunTurnPort;
  hub: ThreadEventHub;
  repos: { turns: TurnRepository };
  eventSink: EventSink;
  workContextDelivery: Pick<WorkContextDelivery, "beforeTurn" | "flushOwned">;
  runAuthority: RunAuthority;
  /**
   * Best-effort notification that a drain run is live and holds its lease.
   * Lets a visibility read model show a woken thread (e.g. a subagent woken by
   * `thread_message`) as running before its first turn event; without it the
   * strip reads `asleep` until the run terminates.
   */
  onRunStarted?: (threadId: ThreadId) => void;
  /**
   * Best-effort notification that a drain run settled and released its lease.
   * Lets a visibility read model refresh after a run the child-run driver did
   * not drive (a child report or `thread_message` waking the thread).
   */
  onRunSettled?: (threadId: ThreadId) => void;
}) {
  const eventSink = deps.eventSink;
  const runAuthority = deps.runAuthority;
  const running = new Map<ThreadId, RunningTurn>();
  const childRuns = new Map<ThreadId, ChildRun>();

  const childRunRegistry: ChildRunRegistry = {
    registerChild(parentThreadId, childThreadId, controller) {
      childRuns.set(childThreadId, { parentThreadId, controller, background: false });
      running.set(childThreadId, { controller, startedAt: new Date() });
    },
    registerBackgroundChild(parentThreadId, childThreadId, controller) {
      childRuns.set(childThreadId, { parentThreadId, controller, background: true });
      running.set(childThreadId, { controller, startedAt: new Date() });
    },
    unregisterChild(childThreadId) {
      childRuns.delete(childThreadId);
      running.delete(childThreadId);
    },
    markChildTurn(childThreadId, assistantTurnId) {
      const child = childRuns.get(childThreadId);
      if (child) {
        running.set(childThreadId, {
          controller: child.controller,
          assistantTurnId,
          startedAt: running.get(childThreadId)?.startedAt ?? new Date(),
        });
      }
    },
    abortChild(childThreadId) {
      this.abortChildrenOf(childThreadId, { includeBackground: true });
      childRuns.get(childThreadId)?.controller.abort();
    },
    abortChildrenOf(parentThreadId, options) {
      for (const [childThreadId, child] of childRuns) {
        if (child.parentThreadId !== parentThreadId) continue;
        if (child.background && !options?.includeBackground) continue;
        child.controller.abort();
        childRuns.delete(childThreadId);
      }
    },
  };

  /**
   * The drain-only run-start path. The live-turn fence, lease acquisition,
   * cursor capture, background drive, and release machinery. The run's first
   * drained message becomes the run's user turn (a writer turn persisted at
   * enqueue is already in the thread and skipped by the drain).
   */
  async function startRun(input: { threadId: ThreadId }): Promise<{
    userTurnId: string;
    assistantTurnId: string;
    resumeAfterSeq: string;
    snapshotFloorNextSeq: string;
  }> {
    if (running.has(input.threadId)) {
      throw new TurnStartConflictError(input.threadId, "already_running");
    }

    const controller = new AbortController();
    let markRunComplete!: () => void;
    const completion = new Promise<void>((resolve) => {
      markRunComplete = resolve;
    });
    const startedAt = new Date();
    running.set(input.threadId, {
      controller,
      completion,
      startedAt,
    });
    let lease: Lease | null = null;
    try {
      lease = await runAuthority.acquire(input.threadId, crypto.randomUUID());
      if (!lease) throw new TurnStartConflictError(input.threadId, "already_running");
      const heldLease: Lease = lease;

      const resumeAfterSeqBeforeStart = (await deps.hub.headSeq(input.threadId)).toString();
      // `beforeTurn` persists any pending work-context `system_update` turn before
      // the run's own turns. If a concurrent run then acks the last message and this
      // drain throws `NoPendingWakeError`, that update turn stays durable with no
      // assistant continuation. It is real history the next run reads, so the
      // invariant is "no phantom assistant turn", not "no write".
      await deps.workContextDelivery.beforeTurn(input.threadId);

      const runInput: RunTurnInput = {
        threadId: input.threadId,
        drain: true,
        signal: controller.signal,
        lease: heldLease,
        onAssistantTurnChanged: (turnId) => {
          const active = running.get(input.threadId);
          if (active) active.assistantTurnId = turnId;
        },
      };

      const handle = await deps.orchestrator.runTurn(runInput);

      // runTurn only constructs a lazy async generator; no generator event can
      // append until the background for-await below begins driving it. Capture
      // the post-setup head now so the floor exactly covers the persisted turns.
      const snapshotFloorNextSeq = ((await deps.hub.headSeq(input.threadId)) + 1n).toString();

      running.set(input.threadId, {
        controller,
        assistantTurnId: handle.assistantTurnId,
        completion,
        startedAt,
      });

      // The run is live and the lease is held. Notify before driving the
      // generator so a woken subagent reads `awake` from the start; a run whose
      // setup throws above never reaches here, so no stale frame is left.
      deps.onRunStarted?.(input.threadId);

      void (async () => {
        try {
          for await (const _event of handle.events) {
            // Events are written to the hub by the orchestrator's emit();
            // the turn-runner just drives the generator.
          }
        } catch (error) {
          emitEvent(eventSink, {
            level: "error",
            source: "runtime.turn-runner",
            name: "generator.failed",
            correlation: {
              threadId: input.threadId,
              turnId: handle.assistantTurnId,
              runId: handle.assistantTurnId,
            },
            payload: {
              threadId: input.threadId,
              assistantTurnId: handle.assistantTurnId,
              ...unknownToEventPayload(error),
            },
          });
          await deps.orchestrator.finalizeGeneratorFailure({
            threadId: input.threadId,
            assistantTurnId: handle.assistantTurnId,
            error,
            signal: controller.signal,
            lease: heldLease,
          });
        } finally {
          running.delete(input.threadId);
          try {
            await deps.workContextDelivery.flushOwned(input.threadId);
          } finally {
            try {
              await runAuthority.release(heldLease);
              childRunRegistry.abortChildrenOf(input.threadId);
            } finally {
              markRunComplete();
              deps.onRunSettled?.(input.threadId);
            }
          }
        }
      })().catch((error) => {
        emitEvent(eventSink, {
          level: "error",
          source: "runtime.turn-runner",
          name: "task.failed",
          correlation: {
            threadId: input.threadId,
            turnId: handle.assistantTurnId,
            runId: handle.assistantTurnId,
          },
          payload: unknownToEventPayload(error),
        });
      });

      return {
        userTurnId: handle.userTurnId,
        assistantTurnId: handle.assistantTurnId,
        resumeAfterSeq: resumeAfterSeqBeforeStart,
        snapshotFloorNextSeq,
      };
    } catch (error) {
      running.delete(input.threadId);
      if (lease) await runAuthority.release(lease);
      throw error;
    }
  }

  /**
   * Starts a drain-only run for a wake. There is no admission to settle; a
   * durable pending message makes the run, and a drained-away message is a no-op.
   * A lost race (a concurrent run already live) is also a no-op.
   */
  async function startDrain(threadId: ThreadId): Promise<void> {
    try {
      await startRun({ threadId });
    } catch (error) {
      // A lost race: a concurrent run acked the last message first. This drain
      // minted no assistant turn; any work-context update persisted by
      // `beforeTurn` is history the next run reads.
      if (error instanceof NoPendingWakeError) return;
      throw error;
    }
  }

  return {
    childRunRegistry,

    /**
     * The runner map is the single liveness authority for a thread run. Returns
     * null when no run is owned here; `assistantTurnId` is null only during the
     * setup window before the orchestrator publishes the container.
     */
    getRunningTurn(threadId: ThreadId): RunningTurnView | null {
      const active = running.get(threadId);
      return active
        ? { assistantTurnId: active.assistantTurnId ?? null, startedAt: active.startedAt }
        : null;
    },

    getRunningTurnId(threadId: ThreadId): TurnId | null {
      return running.get(threadId)?.assistantTurnId ?? null;
    },

    isThreadRunning(threadId: ThreadId): boolean {
      return running.has(threadId);
    },

    startDrain,

    async cancel(
      threadId: ThreadId,
      turnId: TurnId,
    ): Promise<"cancelled" | "already_finished" | "not_found"> {
      const active = running.get(threadId);
      if (active?.assistantTurnId === turnId) {
        // Set the durable flag before aborting: it is the cross-process cancel
        // channel and the truthful `ThreadStatus.cancelRequested`. The local
        // abort is only the fast path.
        if (!(await runAuthority.cancel(threadId, turnId))) return "already_finished";
        childRunRegistry.abortChildrenOf(threadId, { includeBackground: true });
        active.controller.abort();
        if (active.completion) {
          // After this run finalizes as cancelled and releases, the pending
          // message starts the next turn as a drain run. Best-effort; the wake
          // sweep is the durable backstop.
          void active.completion.then(() =>
            createRunStarter({ startDrain }, eventSink).start(threadId),
          );
        }
        return "cancelled";
      }

      const turn = await deps.repos.turns.findById(turnId);
      if (!turn || turn.threadId !== threadId) {
        return "not_found";
      }

      if (isTerminalTurnStatus(turn.status)) {
        return "already_finished";
      }

      if (active) {
        return "already_finished";
      }

      // The guarded update is the cross-process channel, not a prior holder read.
      return (await runAuthority.cancel(threadId, turnId)) ? "cancelled" : "not_found";
    },
  };
}
