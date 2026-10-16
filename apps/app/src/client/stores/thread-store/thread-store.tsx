/**
 * Stores one `SyncedThread` per chat (turns, fences, positions and run state, changed only by the
 * package's transitions) and the app's own per-thread state: pending creation, interrupt responses.
 */

import {
  type Block,
  blockContentRecord,
  compareSeq,
  interruptIdForBlock,
  parseSeq,
  type ThreadListItem,
  type Turn,
  type TurnStatus,
} from "@meridian/contracts/protocol";
import { isTerminalTurnStatus } from "@meridian/contracts/threads";
import {
  createTurnReducer,
  dividersAwaitingAnchorIn,
  INITIAL_RUN_STATE_SLICE,
  isOptimisticTurnId,
  OPTIMISTIC_TURN_ID_PREFIX,
  type RunStateSlice,
  type RunStateView,
} from "@meridian/thread-client";
import * as sync from "@meridian/thread-client/sync";
import {
  EMPTY_SYNCED_THREAD,
  type SyncedCell,
  type SyncedThread,
  syncedTurnStore,
} from "@meridian/thread-client/sync";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
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
import {
  type InterruptResponseEntry,
  interruptResponseKey,
} from "@/core/session/interrupt-response";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { buildOptimisticUserTurn } from "./build-optimistic-user-turn";
import { createThreadCache, type ThreadCachePort } from "./thread-cache";
import type { ThreadStoreActions, ThreadStoreState } from "./types";

type PendingCreationState = {
  threadIds: Record<string, true>;
};

type ThreadStoreSliceState = ThreadStoreState & {
  pendingCreation: PendingCreationState;
  interruptResponses: Record<string, InterruptResponseEntry>;
  /** Monotonic order for the newest-pending error correlation. */
  interruptResponseCounter: number;
  turnCounter: number;
};

type ThreadStoreSlice = ThreadStoreSliceState & ThreadStoreActions;

type ThreadStoreSeed = {
  now: number;
};

type ThreadStoreConfig = ThreadStoreSeed & {
  threadCache: ThreadCachePort;
  /** ISO timestamps for reducer-created rows; tests inject a fixed clock. */
  clock?: () => string;
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
  if (status === "waiting_interrupt") {
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

/** Drop every settlement whose key starts with `prefix`; null when none match. */
function clearInterruptResponsesByPrefix(
  responses: Record<string, InterruptResponseEntry>,
  prefix: string,
): Record<string, InterruptResponseEntry> | null {
  const keys = Object.keys(responses).filter((key) => key.startsWith(prefix));
  if (keys.length === 0) return null;
  const next = { ...responses };
  for (const key of keys) delete next[key];
  return next;
}

/** True once a resolved/expired props payload has been written to the block. */
function interruptBlockHasResolvedValue(block: Block): boolean {
  const props = blockContentRecord(block).props;
  if (!props || typeof props !== "object" || Array.isArray(props)) return false;
  return Object.hasOwn(props, "resolvedValue");
}

function reconcileInterruptResponsesForThread(
  responses: Record<string, InterruptResponseEntry>,
  threadId: string,
  turns: readonly Turn[],
): Record<string, InterruptResponseEntry> | null {
  let next: Record<string, InterruptResponseEntry> | null = null;
  for (const [key, entry] of Object.entries(responses)) {
    if (entry.threadId !== threadId) continue;

    const turn = turns.find((candidate) => candidate.id === entry.turnId);
    const waiting = turn?.status === "waiting_interrupt";
    const block = turn?.blocks.find(
      (candidate) =>
        candidate.blockType === "custom" && interruptIdForBlock(candidate) === entry.interruptId,
    );
    const resolved = block ? interruptBlockHasResolvedValue(block) : false;

    if (!waiting || resolved) {
      next ??= { ...responses };
      delete next[key];
      continue;
    }

    if (entry.status === "pending") {
      next ??= { ...responses };
      next[key] = { ...entry, status: "ambiguous" };
    }
  }
  return next;
}

function selectThreadActions(state: ThreadStoreSlice): ThreadStoreActions {
  return {
    turns: state.turns,
    dividersAwaitingAnchor: state.dividersAwaitingAnchor,
    runState: state.runState,
    setStreamingThreadId: state.setStreamingThreadId,
    ensureThread: state.ensureThread,
    appendUserTurn: state.appendUserTurn,
    acknowledgeUserTurn: state.acknowledgeUserTurn,
    removeOptimisticUserTurn: state.removeOptimisticUserTurn,
    ensureAssistantTurn: state.ensureAssistantTurn,
    ensureSwitchTurn: state.ensureSwitchTurn,
    upsertAssistantBlock: state.upsertAssistantBlock,
    invalidateThreadSnapshot: state.invalidateThreadSnapshot,
    patchTurnStatus: state.patchTurnStatus,
    pruneStaleAssistantTurns: state.pruneStaleAssistantTurns,
    bumpEventsApplied: state.bumpEventsApplied,
    applyTurnEvent: state.applyTurnEvent,
    removeTurns: state.removeTurns,
    markForgotten: state.markForgotten,
    dispatchRunState: state.dispatchRunState,
    applyDurableBlockEvent: state.applyDurableBlockEvent,
    acceptDurableBlockSeq: state.acceptDurableBlockSeq,
    acceptsThreadSnapshot: state.acceptsThreadSnapshot,
    applyThreadSnapshot: state.applyThreadSnapshot,
    markPendingCreation: state.markPendingCreation,
    clearPendingCreation: state.clearPendingCreation,
    interruptResponseFor: state.interruptResponseFor,
    beginInterruptResponse: state.beginInterruptResponse,
    failInterruptResponse: state.failInterruptResponse,
    settleInterruptResponse: state.settleInterruptResponse,
    pendingInterruptResponseForThread: state.pendingInterruptResponseForThread,
    markInterruptResponsesForGenerationAmbiguous:
      state.markInterruptResponsesForGenerationAmbiguous,
  };
}

export function createThreadStore(config: ThreadStoreConfig): ThreadStoreApi {
  const { now, threadCache, clock = () => new Date().toISOString() } = config;
  return createStore<ThreadStoreSlice>()(
    devtools(
      (set, get) => {
        const readCell = (threadId: string): SyncedThread | undefined =>
          get().syncedByThread[threadId];
        const cellOf = (threadId: string): SyncedThread =>
          readCell(threadId) ?? EMPTY_SYNCED_THREAD;
        const withCell = (state: ThreadStoreSlice, threadId: string, next: SyncedThread) => ({
          syncedByThread: { ...state.syncedByThread, [threadId]: next },
        });
        const cell: SyncedCell = {
          get: readCell,
          set: (threadId, next) => set((state) => withCell(state, threadId, next)),
        };
        /** Write the chat's next value; a transition that changed nothing writes nothing. */
        const update = (threadId: string, change: (synced: SyncedThread) => SyncedThread) => {
          const current = cellOf(threadId);
          const next = change(current);
          if (next !== current) cell.set(threadId, next);
        };
        const storeNow = () => new Date(get().now).toISOString();

        // The reducer's side effects: what the thread lists, the caches and the interrupt
        // settlements do when a stream write starts a turn or changes its status.
        const turnStore = syncedTurnStore({
          cell,
          now: storeNow,
          onTurnEnsured(threadId, turnId) {
            threadCache.patchThread(
              threadId,
              liveThreadListPatchForTurnStatus(turnId, "streaming"),
            );
          },
          onStatusPatched(threadId, turnId, status, before) {
            // Unadmitted writer rows carry local knowledge, never a server lifecycle event.
            if (before.role === "user" && isOptimisticTurnId(turnId)) return;
            threadCache.patchThread(threadId, liveThreadListPatchForTurnStatus(turnId, status));
            if (!isTerminalTurnStatus(status)) return;

            reducer.clearPendingInterruptPatchesForTurn(threadId, turnId);
            const state = get();
            const remaining = clearInterruptResponsesByPrefix(
              state.interruptResponses,
              `${threadId}\u0000${turnId}\u0000`,
            );
            if (remaining) set({ interruptResponses: remaining });
            // Cache side effects stay outside Zustand's `set()` call: the terminal
            // reducer path writes store state first, then asks the cache to catch
            // projector-only fields such as final usage/cost metadata. The port
            // owns the render-safe deferral.
            threadCache.invalidateThread(
              threadId,
              state.streamingThreadId === threadId ? state.streamingProjectId : null,
            );
          },
          invalidateThreadSnapshot: (threadId) => threadCache.invalidateThreadSnapshot(threadId),
          settleInterruptResponse: (identity) => get().settleInterruptResponse(identity),
        });
        // One reducer per store: its buffered interrupt patches die with the store.
        const reducer = createTurnReducer({ now: clock, store: turnStore });
        return {
          now,
          syncedByThread: {},
          pendingCreation: { threadIds: {} },
          interruptResponses: {},
          interruptResponseCounter: 0,
          streamingThreadId: null,
          streamingProjectId: null,
          turnCounter: 0,

          turns(id: string) {
            return readCell(id)?.turns;
          },

          dividersAwaitingAnchor(id: string) {
            return dividersAwaitingAnchorIn(cellOf(id));
          },

          runState(id: string) {
            return cellOf(id).runState.view;
          },

          setStreamingThreadId(id, projectId = null) {
            set({ streamingThreadId: id, streamingProjectId: id ? projectId : null });
          },

          ensureThread(thread) {
            threadCache.upsertThread(thread);
            if (!readCell(thread.id)) cell.set(thread.id, EMPTY_SYNCED_THREAD);
          },

          appendUserTurn(threadId, blocks) {
            const { now, turnCounter } = get();
            const { id, next } = nextTurnId(turnCounter);
            const existing = cellOf(threadId).turns;
            const prevTurnId = existing.length > 0 ? existing[existing.length - 1].id : null;
            const turn = buildOptimisticUserTurn({ id, threadId, blocks, now, prevTurnId });

            set((state) => ({
              turnCounter: next,
              ...withCell(
                state,
                threadId,
                sync.appendLocalUserTurn(
                  state.syncedByThread[threadId] ?? EMPTY_SYNCED_THREAD,
                  turn,
                ),
              ),
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

          ensureAssistantTurn: (threadId, turnId, opts) =>
            turnStore.ensureAssistantTurn(threadId, turnId, opts),

          upsertAssistantBlock: (threadId, turnId, block) =>
            turnStore.upsertAssistantBlock(threadId, turnId, block),

          invalidateThreadSnapshot(threadId) {
            threadCache.invalidateThreadSnapshot(threadId);
          },

          patchTurnStatus: (threadId, turnId, status, patch) =>
            turnStore.patchTurnStatus(threadId, turnId, status, patch),

          dispatchRunState(threadId, action) {
            update(threadId, (synced) => sync.receiveRunState(synced, action));
          },

          pruneStaleAssistantTurns(threadId) {
            update(threadId, sync.pruneStreamingTail);
          },

          bumpEventsApplied: (threadId) => turnStore.bumpEventsApplied(threadId),

          applyTurnEvent(threadId, event, seq) {
            reducer.applyEvent(threadId, event, seq);
          },

          ensureSwitchTurn: (threadId, facts, seq) =>
            turnStore.ensureSwitchTurn(threadId, facts, seq),

          removeTurns: (threadId, ids, seq) => turnStore.removeTurns(threadId, ids, seq),

          markForgotten: (threadId, ids, byTurnId) =>
            turnStore.markForgotten(threadId, ids, byTurnId),

          applyDurableBlockEvent(threadId, event) {
            return reducer.applyDurableBlockEvent(threadId, event);
          },

          acceptDurableBlockSeq(threadId, seq) {
            const next = sync.acceptDurableBlockSeq(cellOf(threadId), seq);
            if (!next) return false;
            cell.set(threadId, next);
            return true;
          },

          acceptsThreadSnapshot(threadId, nextSeq) {
            return sync.acceptsSnapshot(cellOf(threadId), nextSeq);
          },

          applyThreadSnapshot(thread, serverTurns, options) {
            const threadId = thread.id;
            const { nextSeq, lifecycle } = options;
            const next = sync.applyRead(cellOf(threadId), {
              turns: serverTurns,
              nextSeq,
              runningTurnId: lifecycle.runningTurnId,
            });
            if (!next) return false;
            threadCache.upsertThread(thread, lifecycle);
            reducer.clearPendingInterruptPatchesForThread(threadId);
            set((state) => {
              const reconciled = reconcileInterruptResponsesForThread(
                state.interruptResponses,
                threadId,
                next.turns,
              );
              return {
                ...withCell(state, threadId, next),
                ...(reconciled ? { interruptResponses: reconciled } : {}),
              };
            });
            return true;
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

          interruptResponseFor(identity) {
            return get().interruptResponses[interruptResponseKey(identity)];
          },

          beginInterruptResponse(input) {
            const key = interruptResponseKey(input);
            set((state) => {
              const sequence = state.interruptResponseCounter + 1;
              return {
                interruptResponseCounter: sequence,
                interruptResponses: {
                  ...state.interruptResponses,
                  [key]: {
                    threadId: input.threadId,
                    turnId: input.turnId,
                    interruptId: input.interruptId,
                    status: "pending",
                    value: input.value,
                    sequence,
                    generation: input.generation,
                  },
                },
              };
            });
          },

          failInterruptResponse(input, failure) {
            const key = interruptResponseKey(input);
            set((state) => {
              const existing = state.interruptResponses[key];
              if (existing) {
                // Preserve the retained value/sequence; only the status moves.
                return {
                  interruptResponses: {
                    ...state.interruptResponses,
                    [key]: { ...existing, status: failure.status },
                  },
                };
              }
              // A send that never left the client has no pending row yet.
              const sequence = state.interruptResponseCounter + 1;
              return {
                interruptResponseCounter: sequence,
                interruptResponses: {
                  ...state.interruptResponses,
                  [key]: {
                    threadId: input.threadId,
                    turnId: input.turnId,
                    interruptId: input.interruptId,
                    status: failure.status,
                    value: input.value,
                    sequence,
                    generation: null,
                  },
                },
              };
            });
          },

          settleInterruptResponse(identity) {
            const key = interruptResponseKey(identity);
            set((state) => {
              if (!(key in state.interruptResponses)) return state;
              const { [key]: _removed, ...rest } = state.interruptResponses;
              return { interruptResponses: rest };
            });
          },

          pendingInterruptResponseForThread(threadId) {
            let newest: InterruptResponseEntry | null = null;
            for (const entry of Object.values(get().interruptResponses)) {
              if (entry.threadId !== threadId || entry.status !== "pending") continue;
              if (!newest || entry.sequence > newest.sequence) newest = entry;
            }
            return newest;
          },

          markInterruptResponsesForGenerationAmbiguous(generation) {
            set((state) => {
              let changed = false;
              const next = { ...state.interruptResponses };
              for (const [key, entry] of Object.entries(state.interruptResponses)) {
                if (entry.status !== "pending" || entry.generation !== generation) continue;
                next[key] = { ...entry, status: "ambiguous" };
                changed = true;
              }
              return changed ? { interruptResponses: next } : state;
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
