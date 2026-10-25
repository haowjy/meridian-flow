/**
 * Stores one `SyncedThread` per chat (turns, fences, positions and run state, changed only by the
 * package's transitions) and the app's own per-thread state, such as pending creation.
 */

import type {
  ThreadListItem,
  ThreadSnapshotResponse,
  Turn,
  TurnStatus,
} from "@meridian/contracts/protocol";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";
import {
  type AskReceipt,
  askReceipt,
  EMPTY_CHAT_ASKS,
  INITIAL_RUN_STATE_SLICE,
  isOptimisticTurnId,
  OPTIMISTIC_TURN_ID_PREFIX,
  type OpenAsk,
  openAsk,
  type RunStateSlice,
  type RunStateView,
} from "@meridian/thread-client";
import * as sync from "@meridian/thread-client/sync";
import {
  EMPTY_SYNCED_THREAD,
  type SyncedThread,
  type SyncObservation,
} from "@meridian/thread-client/sync";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import {
  getChatSubmissionAccountId,
  isThreadAwaitingCreation,
  subscribeChatSubmissions,
} from "@/client/chat-submissions";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { announceError } from "./announcements";
import { buildOptimisticUserTurn } from "./build-optimistic-user-turn";
import { createThreadCache, type ThreadCachePort } from "./thread-cache";
import type { ThreadStoreActions, ThreadStoreState } from "./types";

type PendingCreationState = {
  threadIds: Record<string, true>;
};

type ThreadStoreSliceState = ThreadStoreState & {
  pendingCreation: PendingCreationState;
  turnCounter: number;
};

type ThreadStoreSlice = ThreadStoreSliceState & ThreadStoreActions;

type ThreadStoreSeed = {
  now: number;
};

type ThreadStoreConfig = ThreadStoreSeed & {
  threadCache: ThreadCachePort;
};

type ThreadStoreApi = StoreApi<ThreadStoreSlice>;

/** Generate an optimistic turn ID with the shared local-turn prefix. */
function nextTurnId(counter: number): { id: string; next: number } {
  const next = counter + 1;
  return { id: `${OPTIMISTIC_TURN_ID_PREFIX}${next}`, next };
}

type ThreadListLifecyclePatch = Pick<ThreadListItem, "actionRequired" | "runningTurnId">;

function liveThreadListPatchForTurnStatus(
  turnId: string,
  status: TurnStatus,
): ThreadListLifecyclePatch {
  if (status === "awaiting_answer") {
    return { actionRequired: true, runningTurnId: null };
  }

  if (status === "pending" || status === "streaming") {
    return { actionRequired: false, runningTurnId: turnId };
  }

  return {
    actionRequired: false,
    runningTurnId: null,
  };
}

function selectThreadActions(state: ThreadStoreSlice): ThreadStoreActions {
  return {
    turns: state.turns,
    runState: state.runState,
    syncPorts: state.syncPorts,
    setStreamingThreadId: state.setStreamingThreadId,
    ensureThread: state.ensureThread,
    appendUserTurn: state.appendUserTurn,
    acknowledgeUserTurn: state.acknowledgeUserTurn,
    removeOptimisticUserTurn: state.removeOptimisticUserTurn,
    invalidateThreadSnapshot: state.invalidateThreadSnapshot,
    patchTurnStatus: state.patchTurnStatus,
    pruneStaleAssistantTurns: state.pruneStaleAssistantTurns,
    removeTurns: state.removeTurns,
    dispatchRunState: state.dispatchRunState,
    updateAsks: state.updateAsks,
    markPendingCreation: state.markPendingCreation,
    clearPendingCreation: state.clearPendingCreation,
  };
}

export function createThreadStore(config: ThreadStoreConfig): ThreadStoreApi {
  const { now, threadCache } = config;
  return createStore<ThreadStoreSlice>()(
    devtools(
      (set, get) => {
        const readCell = (threadId: string): SyncedThread | undefined =>
          get().syncedByThread[threadId];
        const cellOf = (threadId: string): SyncedThread =>
          readCell(threadId) ?? EMPTY_SYNCED_THREAD;
        const writeCell = (threadId: string, next: SyncedThread) =>
          set((state) => ({ syncedByThread: { ...state.syncedByThread, [threadId]: next } }));
        /** Write the chat's next value; a transition that changed nothing writes nothing. */
        const update = (threadId: string, change: (synced: SyncedThread) => SyncedThread) => {
          const current = cellOf(threadId);
          const next = change(current);
          if (next !== current) writeCell(threadId, next);
        };
        const storeNow = () => new Date(get().now).toISOString();

        // What the thread lists and the caches do when a turn starts,
        // changes status, or a read lands. The sync's observations and the command actions that
        // cause the same thing both call these.
        const turnChanged = (
          threadId: string,
          turnId: string,
          status: TurnStatus,
          options: { snapshot: boolean },
        ) => {
          threadCache.patchThread(threadId, liveThreadListPatchForTurnStatus(turnId, status));
          if (!isTerminalTurnStatus(status)) return;
          const state = get();
          // Cache side effects stay outside Zustand's `set()` call: the terminal write stores
          // state first, then asks the cache to catch projector-only fields such as final
          // usage/cost metadata. The port owns the render-safe deferral.
          threadCache.invalidateThread(
            threadId,
            state.streamingThreadId === threadId ? state.streamingProjectId : null,
            { snapshot: options.snapshot },
          );
        };
        const readApplied = (_threadId: string, read: ThreadSnapshotResponse) => {
          threadCache.upsertThread(read.thread, {
            actionRequired: read.actionRequired,
            runningTurnId: read.liveState.runState.execution?.currentTurnId ?? null,
          });
        };
        const observe = (threadId: string, observation: SyncObservation) => {
          switch (observation.kind) {
            case "turn":
              // The sync asks for its own read at a turn's end.
              turnChanged(threadId, observation.turnId, observation.status, { snapshot: false });
              break;
            case "read":
              if (observation.applied) readApplied(threadId, observation.read);
              break;
            case "error":
              announceError(observation.error.message || "Thread stream failed");
              break;
            default:
              break;
          }
        };

        return {
          now,
          syncedByThread: {},
          pendingCreation: { threadIds: {} },
          streamingThreadId: null,
          streamingProjectId: null,
          turnCounter: 0,

          turns(id: string) {
            return readCell(id)?.turns;
          },

          runState(id: string) {
            return cellOf(id).runState.view;
          },

          syncPorts(threadId) {
            return {
              state: { get: () => cellOf(threadId), set: (next) => writeCell(threadId, next) },
              observe: (observation) => observe(threadId, observation),
            };
          },

          setStreamingThreadId(id, projectId = null) {
            set({ streamingThreadId: id, streamingProjectId: id ? projectId : null });
          },

          ensureThread(thread) {
            threadCache.upsertThread(thread);
            if (!readCell(thread.id)) writeCell(thread.id, EMPTY_SYNCED_THREAD);
          },

          appendUserTurn(threadId, blocks) {
            const { now, turnCounter } = get();
            const { id, next } = nextTurnId(turnCounter);
            const existing = cellOf(threadId).turns;
            const prevTurnId = existing.length > 0 ? existing[existing.length - 1].id : null;
            const turn = buildOptimisticUserTurn({ id, threadId, blocks, now, prevTurnId });

            set((state) => ({
              turnCounter: next,
              syncedByThread: {
                ...state.syncedByThread,
                [threadId]: sync.appendLocalUserTurn(
                  state.syncedByThread[threadId] ?? EMPTY_SYNCED_THREAD,
                  turn,
                ),
              },
            }));

            return turn;
          },

          acknowledgeUserTurn(threadId, optimisticTurnId, serverTurnId, snapshotFloorNextSeq) {
            update(threadId, (synced) =>
              sync.acknowledgeAdmission(
                synced,
                optimisticTurnId,
                serverTurnId,
                snapshotFloorNextSeq,
                storeNow(),
              ),
            );
          },

          removeOptimisticUserTurn(threadId, optimisticTurnId) {
            update(threadId, (synced) => sync.removeLocalUserTurn(synced, optimisticTurnId));
          },

          invalidateThreadSnapshot(threadId) {
            threadCache.invalidateThreadSnapshot(threadId);
          },

          patchTurnStatus(threadId, turnId, status, patch) {
            const before = readCell(threadId)?.turns.find((turn) => turn.id === turnId);
            if (!before) return;
            update(threadId, (synced) => sync.patchTurnStatus(synced, turnId, status, patch));
            // Unadmitted writer rows carry local knowledge, never a server lifecycle event.
            if (before.role === "user" && isOptimisticTurnId(turnId)) return;
            turnChanged(threadId, turnId, status, { snapshot: true });
          },

          dispatchRunState(threadId, action) {
            update(threadId, (synced) => sync.receiveRunState(synced, action));
          },

          updateAsks(threadId, change) {
            update(threadId, (synced) => sync.updateAsks(synced, change));
          },

          pruneStaleAssistantTurns(threadId) {
            update(threadId, sync.pruneStreamingTail);
          },

          removeTurns(threadId, ids, seq) {
            update(threadId, (synced) => sync.removeTurns(synced, ids, seq));
          },

          markPendingCreation({ threadId }) {
            set((state) => ({
              pendingCreation: {
                threadIds: { ...state.pendingCreation.threadIds, [threadId]: true },
              },
            }));
          },

          clearPendingCreation({ threadId }) {
            set((state) => {
              const threadIds = { ...state.pendingCreation.threadIds };
              if (threadId) delete threadIds[threadId];
              return { pendingCreation: { threadIds } };
            });
          },
        };
      },
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
  const accountSignal = useOptionalAccountEpochSignal();
  const [store] = useState(() =>
    createThreadStore({
      now,
      threadCache: createThreadCache(queryClient, accountSignal ?? undefined),
    }),
  );

  // The QueryClient outlives an account epoch. Retire only account-authorized
  // snapshot Query objects synchronously at close, including inactive threads.
  useLayoutEffect(() => {
    if (!accountSignal) return;
    let retired = false;
    const retireSnapshots = () => {
      if (retired) return;
      retired = true;
      queryClient.removeQueries({
        predicate: ({ queryKey }) =>
          queryKey.length === 3 &&
          queryKey[0] === "threads" &&
          typeof queryKey[1] === "string" &&
          queryKey[2] === "snapshot",
      });
    };
    accountSignal.addEventListener("abort", retireSnapshots, { once: true });
    if (accountSignal.aborted) retireSnapshots();
    return () => {
      accountSignal.removeEventListener("abort", retireSnapshots);
      retireSnapshots();
    };
  }, [accountSignal, queryClient]);

  // Keep `store.now` fresh for relative-time labels ("just now" vs "2 min ago")
  // via a timer instead of relying on route-loader refetches on every navigation.
  useEffect(() => {
    const timer = setInterval(() => {
      store.setState((state) => ({ ...state, now: Date.now() }));
    }, 30_000);
    return () => clearInterval(timer);
  }, [store]);

  return <ThreadStoreContext.Provider value={store}>{children}</ThreadStoreContext.Provider>;
}

export function useThreadStore<T>(selector: (state: ThreadStoreSlice) => T): T {
  return useStore(useThreadStoreApi(), selector);
}

/** The chat's run-state slice: its newest record, this device's intents, and the news the hooks speak. */
export function useRunStateSlice(threadId: string): RunStateSlice {
  return useThreadStore(
    (state) => state.syncedByThread[threadId]?.runState ?? INITIAL_RUN_STATE_SLICE,
  );
}

/** The chat's run-state view, the one input to the package's selectors (`isBusy`, `stopRequest`, ...). */
export function useRunState(threadId: string): RunStateView {
  return useRunStateSlice(threadId).view;
}

const NO_TURNS: Turn[] = [];

/** The ask that takes over the chat's composer, if one is open. */
export function useOpenAsk(threadId: string): OpenAsk | null {
  const asks = useThreadStore((state) => state.syncedByThread[threadId]?.asks ?? EMPTY_CHAT_ASKS);
  const turns = useThreadStore((state) => state.syncedByThread[threadId]?.turns ?? NO_TURNS);
  return useMemo(() => openAsk(asks, turns), [asks, turns]);
}

/** The receipt line an asking turn shows, once its ask is answered here or resolved. */
export function useAskReceipt(threadId: string, turnId: string): AskReceipt | null {
  const asks = useThreadStore((state) => state.syncedByThread[threadId]?.asks ?? EMPTY_CHAT_ASKS);
  return useMemo(() => askReceipt(asks, turnId), [asks, turnId]);
}

export function useThreadActions(): ThreadStoreActions {
  return useStore(useThreadStoreApi(), useShallow(selectThreadActions));
}

/** True when an optimistic thread create is in flight (pre-server confirmation). */
export function useIsThreadPendingCreation(threadId: string | null | undefined): boolean {
  const store = useThreadStoreApi();
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeStore = store.subscribe((state, previous) => {
        if (state.pendingCreation !== previous.pendingCreation) listener();
      });
      const unsubscribeJournal = subscribeChatSubmissions(listener);
      return () => {
        unsubscribeStore();
        unsubscribeJournal();
      };
    },
    [store],
  );
  const snapshot = () =>
    isThreadAwaitingCreation(
      getChatSubmissionAccountId() ?? "",
      threadId,
      Boolean(threadId && store.getState().pendingCreation.threadIds[threadId]),
    );
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
