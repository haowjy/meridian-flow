/**
 * Per-thread turn + coordination state (Zustand vanilla store + React context).
 *
 * Phase 1: project rows live in React Query; project-level soft-delete lives
 * in `ProjectStoreProvider`. This store now holds only per-thread turns,
 * handoff flags, streaming coordination, and the pending-creation gate that
 * the optimistic Home → Project flow uses to suppress fetches until the
 * server-side project + thread exist. Live assistant blocks are written into
 * `turnsByThread`, so chat has one store-backed source of truth.
 */

import type { ThreadListItem, Turn, TurnStatus } from "@meridian/contracts/protocol";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  patchThreadInProjectCaches,
  upsertThreadInProject,
} from "@/client/query/project-thread-cache";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import {
  clearPendingCheckpointPatchesForThread,
  clearPendingCheckpointPatchesForTurn,
} from "@/core/session/reduce-turn-event";
import { baseTurnFields } from "@/core/session/state-helpers";

import { buildOptimisticUserTurn } from "./build-optimistic-user-turn";
import { isOptimisticTurnId, OPTIMISTIC_TURN_ID_PREFIX } from "./optimistic-turn-id";
import { reconcileSnapshotTurns } from "./reconcile-snapshot-turns";
import type {
  EnsureAssistantTurnOptions,
  LiveTurnMeta,
  PendingStreamStart,
  ThreadStoreActions,
  ThreadStoreState,
  TurnStatusPatch,
} from "./types";

/**
 * Pending-creation gate. While a project / thread is being created on the
 * server after an optimistic navigation, queries for that scope return
 * `enabled: false` so they don't fire and 404.
 */
type PendingCreationState = {
  projectIds: Record<string, true>;
  threadIds: Record<string, true>;
};

type ThreadStoreSliceState = ThreadStoreState & {
  turnsByThread: Record<string, Turn[]>;
  handoffPendingThreadIds: Record<string, true>;
  pendingStreamByThreadId: Record<string, PendingStreamStart>;
  pendingCreation: PendingCreationState;
  turnCounter: number;
};

type ThreadStoreSlice = ThreadStoreSliceState & ThreadStoreActions;

type ThreadStoreSeed = {
  now: number;
};

type ThreadStoreConfig = ThreadStoreSeed & {
  queryClient: import("@tanstack/react-query").QueryClient;
};

type ThreadStoreApi = StoreApi<ThreadStoreSlice>;

/**
 * Generate an optimistic turn ID with the shared local-turn prefix.
 *
 * These IDs are never persisted — the server assigns canonical IDs that
 * replace the local ones during snapshot reconciliation. The prefix makes
 * it visually clear which turns are still unconfirmed.
 */
function nextTurnId(counter: number): { id: string; next: number } {
  const next = counter + 1;
  return { id: `${OPTIMISTIC_TURN_ID_PREFIX}${next}`, next };
}

function emptyLiveTurnMeta(): LiveTurnMeta {
  return {
    eventsApplied: 0,
    runningTurnId: null,
  };
}

function liveMetaFor(liveMeta: Record<string, LiveTurnMeta>, threadId: string): LiveTurnMeta {
  return liveMeta[threadId] ?? emptyLiveTurnMeta();
}

type ThreadListLifecyclePatch = Pick<ThreadListItem, "waitingForUser" | "runningTurnId">;

function liveThreadListPatchForTurnStatus(
  turnId: string,
  status: TurnStatus,
): ThreadListLifecyclePatch {
  if (status === "waiting_checkpoint") {
    // A pending checkpoint is an in-run pause for human input. The project
    // thread-list row uses `waitingForUser` for that visible affordance, while
    // `runningTurnId` must clear so the row does not keep showing Working….
    return { waitingForUser: true, runningTurnId: null };
  }

  if (status === "pending" || status === "streaming") {
    return { waitingForUser: false, runningTurnId: turnId };
  }

  return {
    waitingForUser: status === "complete",
    runningTurnId: null,
  };
}

function isPrunableAssistantTransportTail(turn: Turn): boolean {
  // Submit-time pruning runs after the controller has torn down its live
  // subscription. Only a streaming assistant row can be an orphaned transport
  // tail; pending rows and waiting checkpoints are authoritative server state.
  return turn.role === "assistant" && turn.status === "streaming";
}

function createAssistantTurn(
  threadId: string,
  turnId: string,
  now: number,
  existingTurns: readonly Turn[],
  opts?: EnsureAssistantTurnOptions,
): Turn {
  const previousTurn = existingTurns.at(-1);
  const prevTurnId =
    opts && "prevTurnId" in opts ? (opts.prevTurnId ?? null) : (previousTurn?.id ?? null);
  return {
    id: turnId,
    threadId,
    prevTurnId,
    role: "assistant",
    status: "streaming",
    finishReason: null,
    ...baseTurnFields(),
    error: null,
    createdAt: opts?.createdAt ?? new Date(now).toISOString(),
    completedAt: null,
    blocks: [],
    siblingIds: [],
    responses: [],
  };
}

function definedTurnStatusPatch(patch: TurnStatusPatch): TurnStatusPatch {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as TurnStatusPatch;
}

function selectThreadActions(state: ThreadStoreSlice): ThreadStoreActions {
  return {
    turns: state.turns,
    rename: state.rename,
    setStreamingThreadId: state.setStreamingThreadId,
    ensureThread: state.ensureThread,
    markHandoffPending: state.markHandoffPending,
    appendUserTurn: state.appendUserTurn,
    acknowledgeUserTurn: state.acknowledgeUserTurn,
    removeOptimisticUserTurn: state.removeOptimisticUserTurn,
    ensureAssistantTurn: state.ensureAssistantTurn,
    upsertAssistantBlock: state.upsertAssistantBlock,
    patchTurnStatus: state.patchTurnStatus,
    pruneStaleAssistantTurns: state.pruneStaleAssistantTurns,
    bumpEventsApplied: state.bumpEventsApplied,
    applyThreadSnapshot: state.applyThreadSnapshot,
    markPendingStream: state.markPendingStream,
    consumePendingStream: state.consumePendingStream,
    markPendingCreation: state.markPendingCreation,
    clearPendingCreation: state.clearPendingCreation,
  };
}

export function createThreadStore(config: ThreadStoreConfig): ThreadStoreApi {
  const { now, queryClient } = config;
  return createStore<ThreadStoreSlice>()(
    devtools(
      (set, get) => ({
        now,
        turnsByThread: {},
        liveMeta: {},
        handoffPendingThreadIds: {},
        pendingStreamByThreadId: {},
        pendingCreation: { projectIds: {}, threadIds: {} },
        streamingThreadId: null,
        streamingProjectId: null,
        turnCounter: 0,

        turns(id: string) {
          return get().turnsByThread[id];
        },

        rename(id, title) {
          const next = title.trim() ? title.trim() : null;
          patchThreadInProjectCaches(queryClient, id, {
            title: next,
            updatedAt: new Date().toISOString(),
          });
        },

        setStreamingThreadId(id, projectId = null) {
          set({ streamingThreadId: id, streamingProjectId: id ? projectId : null });
        },

        ensureThread(thread) {
          upsertThreadInProject(queryClient, thread);
          set((state) =>
            thread.id in state.turnsByThread
              ? state
              : { turnsByThread: { ...state.turnsByThread, [thread.id]: [] } },
          );
        },

        markHandoffPending(threadId) {
          set((state) => ({
            handoffPendingThreadIds: { ...state.handoffPendingThreadIds, [threadId]: true },
          }));
        },

        appendUserTurn(threadId, text) {
          const { now, turnCounter } = get();
          const { id, next } = nextTurnId(turnCounter);
          const existing = get().turnsByThread[threadId] ?? [];
          const prevTurnId = existing.length > 0 ? existing[existing.length - 1].id : null;
          const turn = buildOptimisticUserTurn({ id, threadId, text, now, prevTurnId });

          set((state) => {
            const existing = state.turnsByThread[threadId] ?? [];
            return {
              turnCounter: next,
              turnsByThread: { ...state.turnsByThread, [threadId]: [...existing, turn] },
            };
          });

          return turn;
        },

        acknowledgeUserTurn(threadId, optimisticTurnId, serverTurnId) {
          if (!serverTurnId || optimisticTurnId === serverTurnId) return;

          set((state) => {
            if (!isOptimisticTurnId(optimisticTurnId)) return state;

            const turns = state.turnsByThread[threadId] ?? [];
            const optimisticTurn = turns.find((turn) => turn.id === optimisticTurnId);
            if (optimisticTurn?.role !== "user") return state;

            const hasServerTurn = turns.some((turn) => turn.id === serverTurnId);

            /**
             * The POST /messages response is the explicit identity bridge from
             * the local `turn_local_*` row to the persisted user turn. Snapshots
             * only carry server IDs, so the client must rewrite the local row
             * as soon as the append is acknowledged; otherwise by-id snapshot
             * reconcile has no way to know the optimistic and server rows are
             * the same user message.
             */
            const nextTurns = turns
              .filter((turn) => !(hasServerTurn && turn.id === optimisticTurnId))
              .map((turn) => {
                if (turn.id === optimisticTurnId) {
                  return {
                    ...turn,
                    id: serverTurnId,
                    blocks: turn.blocks.map((block) => ({ ...block, turnId: serverTurnId })),
                  };
                }
                if (turn.prevTurnId === optimisticTurnId) {
                  return { ...turn, prevTurnId: serverTurnId };
                }
                return turn;
              });

            return { turnsByThread: { ...state.turnsByThread, [threadId]: nextTurns } };
          });
        },

        removeOptimisticUserTurn(threadId, optimisticTurnId) {
          set((state) => {
            const turns = state.turnsByThread[threadId] ?? [];
            const nextTurns = turns.filter((turn) => turn.id !== optimisticTurnId);
            if (nextTurns.length === turns.length) return state;
            return { turnsByThread: { ...state.turnsByThread, [threadId]: nextTurns } };
          });
        },

        ensureAssistantTurn(threadId, turnId, opts) {
          let threadListPatch: ThreadListLifecyclePatch | null = null;

          set((state) => {
            const existing = state.turnsByThread[threadId] ?? [];
            const existingTurn = existing.find((turn) => turn.id === turnId);
            if (existingTurn) {
              if (existingTurn.role !== "assistant") return state;

              threadListPatch = liveThreadListPatchForTurnStatus(turnId, "streaming");

              const meta = liveMetaFor(state.liveMeta, threadId);
              return {
                liveMeta: {
                  ...state.liveMeta,
                  [threadId]: { ...meta, runningTurnId: turnId },
                },
              };
            }

            const meta = liveMetaFor(state.liveMeta, threadId);
            const liveMeta = {
              ...state.liveMeta,
              [threadId]: { ...meta, runningTurnId: turnId },
            };

            const turn = createAssistantTurn(threadId, turnId, state.now, existing, opts);
            threadListPatch = liveThreadListPatchForTurnStatus(turnId, turn.status);
            return {
              liveMeta,
              turnsByThread: { ...state.turnsByThread, [threadId]: [...existing, turn] },
            };
          });

          if (threadListPatch) {
            patchThreadInProjectCaches(queryClient, threadId, threadListPatch);
          }
        },

        upsertAssistantBlock(threadId, turnId, block) {
          set((state) => {
            const turns = state.turnsByThread[threadId] ?? [];
            const turnIndex = turns.findIndex((turn) => turn.id === turnId);
            if (turnIndex < 0) return state;

            const turn = turns[turnIndex];
            if (!turn) return state;

            const normalizedBlock = block.turnId === turnId ? block : { ...block, turnId };
            const blocks = [
              ...turn.blocks.filter((existingBlock) => existingBlock.sequence !== block.sequence),
              normalizedBlock,
            ].sort((a, b) => a.sequence - b.sequence);

            /**
             * `sequence` is the block identity within a turn. Upserting by it,
             * instead of append order, makes live tail events and snapshot head
             * blocks commute when they arrive in either order.
             */
            const nextTurns = turns.map((existingTurn, index) =>
              index === turnIndex ? { ...existingTurn, blocks } : existingTurn,
            );
            const turnsByThread = { ...state.turnsByThread, [threadId]: nextTurns };
            return { turnsByThread };
          });
        },

        patchTurnStatus(threadId, turnId, status, patch = {}) {
          let terminalProjectId: string | null = null;
          let shouldInvalidateSnapshot = false;
          let threadListPatch: ThreadListLifecyclePatch | null = null;

          set((state) => {
            const turns = state.turnsByThread[threadId] ?? [];
            const turnIndex = turns.findIndex((turn) => turn.id === turnId);
            if (turnIndex < 0) return state;

            const definedPatch = definedTurnStatusPatch(patch);
            threadListPatch = liveThreadListPatchForTurnStatus(turnId, status);
            const nextTurns = turns.map((turn, index) =>
              index === turnIndex ? { ...turn, ...definedPatch, status } : turn,
            );
            if (!isTerminalTurnStatus(status)) {
              return { turnsByThread: { ...state.turnsByThread, [threadId]: nextTurns } };
            }

            clearPendingCheckpointPatchesForTurn(threadId, turnId);
            shouldInvalidateSnapshot = true;
            terminalProjectId =
              state.streamingThreadId === threadId ? state.streamingProjectId : null;

            const meta = liveMetaFor(state.liveMeta, threadId);
            const isRunningTurn = meta.runningTurnId === turnId;
            return {
              liveMeta: {
                ...state.liveMeta,
                [threadId]: {
                  ...meta,
                  runningTurnId: isRunningTurn ? null : meta.runningTurnId,
                },
              },
              turnsByThread: { ...state.turnsByThread, [threadId]: nextTurns },
            };
          });

          if (threadListPatch) {
            patchThreadInProjectCaches(queryClient, threadId, threadListPatch);
          }

          if (!shouldInvalidateSnapshot) return;
          // React Query side effects stay outside Zustand's `set()` call; the
          // terminal reducer path writes store state first, then asks snapshots
          // to catch projector-only fields such as final usage/cost metadata.
          queueMicrotask(() => {
            void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
            if (terminalProjectId) {
              void queryClient.invalidateQueries({
                queryKey: projectQueryKeys.threads(terminalProjectId),
              });
            }
          });
        },

        pruneStaleAssistantTurns(threadId) {
          set((state) => {
            const turns = state.turnsByThread[threadId] ?? [];
            const nextTurns = turns.filter((turn) => !isPrunableAssistantTransportTail(turn));
            if (nextTurns.length === turns.length) return state;

            const meta = liveMetaFor(state.liveMeta, threadId);
            return {
              liveMeta: {
                ...state.liveMeta,
                [threadId]: {
                  ...meta,
                  runningTurnId: null,
                },
              },
              turnsByThread: { ...state.turnsByThread, [threadId]: nextTurns },
            };
          });
        },

        bumpEventsApplied(threadId) {
          let nextEventsApplied = 0;
          set((state) => {
            const meta = liveMetaFor(state.liveMeta, threadId);
            nextEventsApplied = meta.eventsApplied + 1;
            return {
              liveMeta: {
                ...state.liveMeta,
                [threadId]: { ...meta, eventsApplied: nextEventsApplied },
              },
            };
          });
          return nextEventsApplied;
        },

        applyThreadSnapshot(thread, serverTurns, lifecycle) {
          const threadId = thread.id;
          /**
           * Handoff: the optimistic Home → Project navigation flow.
           *
           * When the user creates a project from Home, the client
           * optimistically creates the thread + project and navigates
           * before the server confirms. While waiting, the server may
           * return an empty snapshot (the thread doesn't exist yet). In
           * that case, `keepLocalTurns = true` preserves the optimistic
           * local turns so the UI doesn't flash blank.
           *
           * Once the server returns real turns (handoffComplete), the
           * local optimistic turns are merged with server data via
           * `reconcileSnapshotTurns`.
           */
          const handoffPending = Boolean(get().handoffPendingThreadIds[threadId]);
          const keepLocalTurns = handoffPending && serverTurns.length === 0;

          upsertThreadInProject(queryClient, thread, lifecycle);
          if (!keepLocalTurns) {
            clearPendingCheckpointPatchesForThread(threadId);
          }

          set((state) => {
            const handoffPendingThreadIds = { ...state.handoffPendingThreadIds };
            if (!keepLocalTurns) {
              delete handoffPendingThreadIds[threadId];
            }

            if (keepLocalTurns) {
              return { handoffPendingThreadIds };
            }

            const localTurns = state.turnsByThread[threadId] ?? [];
            const runningTurnId = lifecycle?.runningTurnId ?? null;
            const mergedTurns = reconcileSnapshotTurns(localTurns, serverTurns, { runningTurnId });

            const nextState: Partial<ThreadStoreSliceState> = {
              handoffPendingThreadIds,
              turnsByThread: { ...state.turnsByThread, [threadId]: mergedTurns },
            };

            if (lifecycle && "runningTurnId" in lifecycle) {
              const meta = liveMetaFor(state.liveMeta, threadId);
              nextState.liveMeta = {
                ...state.liveMeta,
                [threadId]: {
                  ...meta,
                  runningTurnId,
                },
              };
            }

            return nextState;
          });
        },

        markPendingStream(threadId, start) {
          set((state) => ({
            pendingStreamByThreadId: {
              ...state.pendingStreamByThreadId,
              [threadId]: start ?? {},
            },
          }));
        },

        /**
         * One-shot read-and-remove of pending stream metadata.
         *
         * The pending stream is consumed by the chat handoff
         * exactly once — the metadata carries the first-message text
         * and thread creation flags that the agent uses to begin the
         * conversation. It must not be re-read (would resend the message)
         * or left in the store (would pollute the next run).
         */
        consumePendingStream(threadId) {
          const pending = get().pendingStreamByThreadId[threadId];
          if (!pending) return null;
          set((state) => {
            const { [threadId]: _removed, ...pendingStreamByThreadId } =
              state.pendingStreamByThreadId;
            return { pendingStreamByThreadId };
          });
          return pending;
        },

        markPendingCreation({ projectId, threadId }) {
          set((state) => ({
            pendingCreation: {
              projectIds: projectId
                ? { ...state.pendingCreation.projectIds, [projectId]: true }
                : state.pendingCreation.projectIds,
              threadIds: { ...state.pendingCreation.threadIds, [threadId]: true },
            },
          }));
        },

        clearPendingCreation({ projectId, threadId }) {
          set((state) => {
            const projectIds = { ...state.pendingCreation.projectIds };
            const threadIds = { ...state.pendingCreation.threadIds };
            if (projectId) delete projectIds[projectId];
            if (threadId) delete threadIds[threadId];
            return { pendingCreation: { projectIds, threadIds } };
          });
        },
      }),
      { name: "thread-store", enabled: import.meta.env.DEV },
    ),
  );
}

const ThreadStoreContext = createContext<ThreadStoreApi | null>(null);

function useThreadStoreApi(): ThreadStoreApi {
  const store = useContext(ThreadStoreContext);
  if (!store) {
    throw new Error("useThreadStore must be used within ThreadStoreProvider");
  }
  return store;
}

export function ThreadStoreProvider({ now, children }: ThreadStoreSeed & { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [store] = useState(() => createThreadStore({ now, queryClient }));

  /**
   * Keep `store.now` in sync with the route loader's `now` prop.
   *
   * `now` changes on every navigation (route loader re-fetches), and
   * the store uses it for relative-time labels in chat ("just now" vs
   * "2 min ago"). Without syncing, time labels would stick at the
   * stale value from when the store was first created.
   */
  useEffect(() => {
    store.setState((state) => (state.now === now ? state : { ...state, now }));
  }, [store, now]);

  return <ThreadStoreContext.Provider value={store}>{children}</ThreadStoreContext.Provider>;
}

export function useThreadStore<T>(selector: (state: ThreadStoreSlice) => T): T {
  return useStore(useThreadStoreApi(), selector);
}

export function useThreadActions(): ThreadStoreActions {
  return useStore(useThreadStoreApi(), useShallow(selectThreadActions));
}

/** True when an optimistic project create is in flight (pre-server confirmation). */
export function useIsProjectPendingCreation(projectId: string | null | undefined): boolean {
  return useThreadStore((s) =>
    projectId ? Boolean(s.pendingCreation.projectIds[projectId]) : false,
  );
}

/** True when an optimistic thread create is in flight (pre-server confirmation). */
export function useIsThreadPendingCreation(threadId: string | null | undefined): boolean {
  return useThreadStore((s) => (threadId ? Boolean(s.pendingCreation.threadIds[threadId]) : false));
}
