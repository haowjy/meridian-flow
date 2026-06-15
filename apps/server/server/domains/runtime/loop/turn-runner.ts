/**
 * Turn runner: tracks in-flight turns and their AbortControllers so a turn
 * can be started, looked up, and cancelled. Owns the live-turn registry
 * layered over the orchestrator; depends on the orchestrator and thread
 * event hub.
 *
 * Design:
 *
 * - **One running turn per thread**: the `running` Map (ThreadId →
 *   RunningTurn) enforces mutual exclusion. `startTurn` rejects if a turn
 *   is already active for that thread.
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
 * - **Cancel**: calls `AbortController.abort()`, which the orchestrator
 *   checks at every yield point. If no running turn is found, falls back
 *   to checking the persisted turn status (handles crash recovery: a
 *   running map is empty after restart, but a turn in "streaming" state
 *   may still need cancellation cleanup).
 *
 * - **Child runs**: spawn-driven child turns register under their parent so
 *   parent cancel propagates parent→child.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { ThreadEventHub, TurnRepository } from "../../threads/index.js";
import type { HelperResultDelivery } from "../spawn/helper-result-delivery.js";
import type { RunTurnPort } from "./run-turn-port.js";

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
  abortChild(childThreadId: ThreadId): void;
  abortChildrenOf(parentThreadId: ThreadId, options?: { includeBackground?: boolean }): void;
}

type RunningTurn = {
  controller: AbortController;
  assistantTurnId?: TurnId;
  connectionToken?: string;
};

type ChildRun = {
  parentThreadId: ThreadId | null;
  controller: AbortController;
  background: boolean;
};

export class StaleConnectionTokenError extends Error {
  constructor() {
    super("connection_token_not_live");
    this.name = "StaleConnectionTokenError";
  }
}

export function createTurnRunner(deps: {
  orchestrator: RunTurnPort;
  hub: ThreadEventHub;
  repos: { turns: TurnRepository };
  eventSink: EventSink;
  helperResultDelivery?: Pick<HelperResultDelivery, "flush">;
}) {
  const eventSink = deps.eventSink;
  const running = new Map<ThreadId, RunningTurn>();
  /** connectionToken → threads with in-flight turns owned by that peer. */
  const threadsByConnectionToken = new Map<string, Set<ThreadId>>();
  /** WS peers currently connected; a token not in this set cannot own a new turn. */
  const liveConnectionTokens = new Set<string>();
  const childRuns = new Map<ThreadId, ChildRun>();

  function assertConnectionTokenLive(connectionToken: string | undefined): void {
    if (!connectionToken) return;
    if (!liveConnectionTokens.has(connectionToken)) {
      throw new StaleConnectionTokenError();
    }
  }

  function registerConnectionOwnership(
    connectionToken: string | undefined,
    threadId: ThreadId,
  ): void {
    if (!connectionToken) return;
    let owned = threadsByConnectionToken.get(connectionToken);
    if (!owned) {
      owned = new Set();
      threadsByConnectionToken.set(connectionToken, owned);
    }
    owned.add(threadId);
  }

  function unregisterConnectionOwnership(
    connectionToken: string | undefined,
    threadId: ThreadId,
  ): void {
    if (!connectionToken) return;
    const owned = threadsByConnectionToken.get(connectionToken);
    if (!owned) return;
    owned.delete(threadId);
    if (owned.size === 0) threadsByConnectionToken.delete(connectionToken);
  }

  const childRunRegistry: ChildRunRegistry = {
    registerChild(parentThreadId, childThreadId, controller) {
      childRuns.set(childThreadId, { parentThreadId, controller, background: false });
    },
    registerBackgroundChild(parentThreadId, childThreadId, controller) {
      childRuns.set(childThreadId, { parentThreadId, controller, background: true });
    },
    unregisterChild(childThreadId) {
      childRuns.delete(childThreadId);
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

  return {
    childRunRegistry,

    registerLiveConnectionToken(connectionToken: string): void {
      liveConnectionTokens.add(connectionToken);
    },

    unregisterLiveConnectionToken(connectionToken: string): void {
      liveConnectionTokens.delete(connectionToken);
    },

    getRunningTurnId(threadId: ThreadId): TurnId | null {
      return running.get(threadId)?.assistantTurnId ?? null;
    },

    getRunningConnectionToken(threadId: ThreadId): string | undefined {
      return running.get(threadId)?.connectionToken;
    },

    cancelTurnsOwnedByConnectionToken(connectionToken: string): void {
      const ownedThreads = threadsByConnectionToken.get(connectionToken);
      if (!ownedThreads) return;
      for (const threadId of [...ownedThreads]) {
        const active = running.get(threadId);
        if (!active || active.connectionToken !== connectionToken) continue;
        if (active.assistantTurnId) {
          void this.cancel(threadId, active.assistantTurnId);
        } else {
          childRunRegistry.abortChildrenOf(threadId, { includeBackground: true });
          active.controller.abort();
        }
      }
    },

    async startTurn(input: {
      threadId: ThreadId;
      userText: string;
      connectionToken?: string;
    }): Promise<{ userTurnId: string; assistantTurnId: string; streamCursor: string }> {
      if (running.has(input.threadId)) {
        throw new Error(`Turn already running for thread: ${input.threadId}`);
      }

      assertConnectionTokenLive(input.connectionToken);

      const controller = new AbortController();
      running.set(input.threadId, {
        controller,
        connectionToken: input.connectionToken,
      });
      registerConnectionOwnership(input.connectionToken, input.threadId);

      try {
        assertConnectionTokenLive(input.connectionToken);

        const streamCursorBeforeStart = (await deps.hub.headSeq(input.threadId)).toString();

        const handle = await deps.orchestrator.runTurn({
          threadId: input.threadId,
          userText: input.userText,
          signal: controller.signal,
        });

        running.set(input.threadId, {
          controller,
          assistantTurnId: handle.assistantTurnId,
          connectionToken: input.connectionToken,
        });

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
              payload: {
                threadId: input.threadId,
                assistantTurnId: handle.assistantTurnId,
                ...unknownToEventPayload(error),
              },
            });
          } finally {
            unregisterConnectionOwnership(input.connectionToken, input.threadId);
            running.delete(input.threadId);
            await deps.helperResultDelivery?.flush(input.threadId);
            childRunRegistry.abortChildrenOf(input.threadId);
          }
        })();

        return {
          userTurnId: handle.userTurnId,
          assistantTurnId: handle.assistantTurnId,
          streamCursor: streamCursorBeforeStart,
        };
      } catch (error) {
        unregisterConnectionOwnership(input.connectionToken, input.threadId);
        running.delete(input.threadId);
        throw error;
      }
    },

    async cancel(
      threadId: ThreadId,
      turnId: TurnId,
    ): Promise<"cancelled" | "already_finished" | "not_found"> {
      const active = running.get(threadId);
      if (active?.assistantTurnId === turnId) {
        childRunRegistry.abortChildrenOf(threadId, { includeBackground: true });
        active.controller.abort();
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

      return "not_found";
    },
  };
}
