/** Stores per-thread turns and run coordination state. */

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
  applySnapshotTo,
  createTurnReducer,
  ensureAssistantTurnIn,
  isOptimisticTurnId,
  OPTIMISTIC_TURN_ID_PREFIX,
  patchTurnStatusIn,
  type RunStateView,
  removeTurnsIn,
  type Tombstones,
  upsertBlockIn,
} from "@meridian/thread-client";
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
  INITIAL_RUN_STATE_SLICE,
  type RunStateSlice,
  reduceRunState,
} from "@/client/run-state/run-state-slice";
import {
  type InterruptResponseEntry,
  interruptResponseKey,
} from "@/core/session/interrupt-response";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { buildOptimisticUserTurn } from "./build-optimistic-user-turn";
import { reconcileSnapshotTurns } from "./reconcile-snapshot-turns";
import { createThreadCache, type ThreadCachePort } from "./thread-cache";
import type { LiveTurnMeta, ThreadStoreActions, ThreadStoreState } from "./types";

type PendingCreationState = {
  threadIds: Record<string, true>;
};

type ThreadStoreSliceState = ThreadStoreState & {
  turnsByThread: Record<string, Turn[]>;
  /** Each chat's run state: the newest record, this device's unanswered intents, and what is news. */
  runStateByThread: Record<string, RunStateSlice>;
  /** Minimum snapshot nextSeq accepted; snapshots below this floor are rejected. */
  snapshotNextSeqFloorByThread: Record<string, string>;
  /** Turns removed from the conversation, until a snapshot covering the removal arrives. */
  tombstonesByThread: Record<string, Tombstones>;
  durableBlockCursorByThread: Record<string, string>;
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

function emptyLiveTurnMeta(): LiveTurnMeta {
  return {
    eventsApplied: 0,
    runningTurnId: null,
  };
}

function liveMetaFor(liveMeta: Record<string, LiveTurnMeta>, threadId: string): LiveTurnMeta {
  return liveMeta[threadId] ?? emptyLiveTurnMeta();
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

function isPrunableAssistantTransportTail(turn: Turn): boolean {
  // Submit-time pruning runs after the controller has torn down its live
  // subscription. Only a streaming assistant row can be an orphaned transport
  // tail; pending rows and waiting interrupts are authoritative server state.
  return turn.role === "assistant" && turn.status === "streaming";
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
    runState: state.runState,
    setStreamingThreadId: state.setStreamingThreadId,
    ensureThread: state.ensureThread,
    appendUserTurn: state.appendUserTurn,
    acknowledgeUserTurn: state.acknowledgeUserTurn,
    removeOptimisticUserTurn: state.removeOptimisticUserTurn,
    ensureAssistantTurn: state.ensureAssistantTurn,
    upsertAssistantBlock: state.upsertAssistantBlock,
    invalidateThreadSnapshot: state.invalidateThreadSnapshot,
    patchTurnStatus: state.patchTurnStatus,
    pruneStaleAssistantTurns: state.pruneStaleAssistantTurns,
    bumpEventsApplied: state.bumpEventsApplied,
    applyTurnEvent: state.applyTurnEvent,
    removeTurns: state.removeTurns,
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
        // One reducer per store: its buffered interrupt patches die with the store.
        const reducer = createTurnReducer({
          now: clock,
          store: {
            turns: (threadId) => get().turns(threadId),
            ensureAssistantTurn: (...args) => get().ensureAssistantTurn(...args),
            upsertAssistantBlock: (...args) => get().upsertAssistantBlock(...args),
            invalidateThreadSnapshot: (threadId) => get().invalidateThreadSnapshot(threadId),
            patchTurnStatus: (...args) => get().patchTurnStatus(...args),
            removeTurns: (...args) => get().removeTurns(...args),
            bumpEventsApplied: (threadId) => get().bumpEventsApplied(threadId),
            settleInterruptResponse: (identity) => get().settleInterruptResponse(identity),
          },
        });
        return {
          now,
          turnsByThread: {},
          runStateByThread: {},
          snapshotNextSeqFloorByThread: {},
          tombstonesByThread: {},
          durableBlockCursorByThread: {},
          liveMeta: {},
          pendingCreation: { threadIds: {} },
          interruptResponses: {},
          interruptResponseCounter: 0,
          streamingThreadId: null,
          streamingProjectId: null,
          turnCounter: 0,

          turns(id: string) {
            return get().turnsByThread[id];
          },

          runState(id: string) {
            return (get().runStateByThread[id] ?? INITIAL_RUN_STATE_SLICE).view;
          },

          setStreamingThreadId(id, projectId = null) {
            set({ streamingThreadId: id, streamingProjectId: id ? projectId : null });
          },

          ensureThread(thread) {
            threadCache.upsertThread(thread);
            set((state) =>
              thread.id in state.turnsByThread
                ? state
                : { turnsByThread: { ...state.turnsByThread, [thread.id]: [] } },
            );
          },

          appendUserTurn(threadId, blocks) {
            const { now, turnCounter } = get();
            const { id, next } = nextTurnId(turnCounter);
            const existing = get().turnsByThread[threadId] ?? [];
            const prevTurnId = existing.length > 0 ? existing[existing.length - 1].id : null;
            const turn = buildOptimisticUserTurn({ id, threadId, blocks, now, prevTurnId });

            set((state) => {
              const existing = state.turnsByThread[threadId] ?? [];
              return {
                turnCounter: next,
                turnsByThread: { ...state.turnsByThread, [threadId]: [...existing, turn] },
              };
            });

            return turn;
          },

          acknowledgeUserTurn(threadId, optimisticTurnId, serverTurnId, snapshotFloorNextSeq) {
            if (optimisticTurnId === serverTurnId) return;

            set((state) => {
              if (!isOptimisticTurnId(optimisticTurnId)) return state;

              const turns = state.turnsByThread[threadId] ?? [];
              const optimisticTurn = turns.find((turn) => turn.id === optimisticTurnId);
              if (optimisticTurn?.role !== "user") return state;

              // Another tab handed this message back before the answer arrived: the row goes
              // instead of becoming the turn that left the conversation.
              const handedBack = state.tombstonesByThread[threadId]?.has(serverTurnId) === true;
              const hasServerTurn = handedBack || turns.some((turn) => turn.id === serverTurnId);

              /** The POST /messages response is the explicit identity bridge from the local `turn_local_*` row to the persisted user turn. */
              const nextTurns = turns
                .filter((turn) => !(hasServerTurn && turn.id === optimisticTurnId))
                .map((turn) => {
                  if (turn.id === optimisticTurnId) {
                    // The acknowledgement is the explicit bridge from the local
                    // pending row to the admitted server turn; settle it here so
                    // the row stops reading as pending before the snapshot lands.
                    return {
                      ...turn,
                      id: serverTurnId,
                      status: "complete" as const,
                      completedAt: turn.completedAt ?? new Date(state.now).toISOString(),
                      blocks: turn.blocks.map((block) => ({ ...block, turnId: serverTurnId })),
                    };
                  }
                  if (turn.prevTurnId === optimisticTurnId) {
                    return { ...turn, prevTurnId: serverTurnId };
                  }
                  return turn;
                });

              // Never let an older acknowledgement move the snapshot floor backwards.
              const acknowledgedNextSeq = BigInt(snapshotFloorNextSeq);
              const currentNextSeq = state.snapshotNextSeqFloorByThread[threadId];
              const nextSeq =
                currentNextSeq === undefined || acknowledgedNextSeq > BigInt(currentNextSeq)
                  ? acknowledgedNextSeq.toString()
                  : currentNextSeq;

              return {
                snapshotNextSeqFloorByThread: {
                  ...state.snapshotNextSeqFloorByThread,
                  [threadId]: nextSeq,
                },
                turnsByThread: { ...state.turnsByThread, [threadId]: nextTurns },
              };
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
              const result = ensureAssistantTurnIn(
                state.turnsByThread[threadId] ?? [],
                threadId,
                turnId,
                new Date(state.now).toISOString(),
                opts,
              );
              if (result.kind === "rejected") return state;
              const existing = state.turnsByThread[threadId] ?? [];

              threadListPatch = liveThreadListPatchForTurnStatus(turnId, "streaming");
              const meta = liveMetaFor(state.liveMeta, threadId);
              return {
                liveMeta: {
                  ...state.liveMeta,
                  [threadId]: { ...meta, runningTurnId: turnId },
                },
                turnsByThread:
                  result.turns === existing
                    ? state.turnsByThread
                    : { ...state.turnsByThread, [threadId]: result.turns },
              };
            });

            if (threadListPatch) {
              threadCache.patchThread(threadId, threadListPatch);
            }
          },

          upsertAssistantBlock(threadId, turnId, block) {
            set((state) => {
              const nextTurns = upsertBlockIn(state.turnsByThread[threadId] ?? [], turnId, block);
              if (!nextTurns) return state;
              return { turnsByThread: { ...state.turnsByThread, [threadId]: nextTurns } };
            });
          },

          invalidateThreadSnapshot(threadId) {
            threadCache.invalidateThreadSnapshot(threadId);
          },

          patchTurnStatus(threadId, turnId, status, patch = {}) {
            let terminalProjectId: string | null = null;
            let shouldInvalidateSnapshot = false;
            let threadListPatch: ThreadListLifecyclePatch | null = null;

            set((state) => {
              const turns = state.turnsByThread[threadId] ?? [];
              const turnIndex = turns.findIndex((turn) => turn.id === turnId);
              if (turnIndex < 0) return state;

              const nextTurns = patchTurnStatusIn(turns, turnId, status, patch) ?? turns;
              // Unadmitted writer rows carry local knowledge, never a server lifecycle event.
              if (turns[turnIndex]?.role === "user" && isOptimisticTurnId(turnId)) {
                return { turnsByThread: { ...state.turnsByThread, [threadId]: nextTurns } };
              }
              threadListPatch = liveThreadListPatchForTurnStatus(turnId, status);
              if (!isTerminalTurnStatus(status)) {
                return { turnsByThread: { ...state.turnsByThread, [threadId]: nextTurns } };
              }

              reducer.clearPendingInterruptPatchesForTurn(threadId, turnId);
              shouldInvalidateSnapshot = true;
              terminalProjectId =
                state.streamingThreadId === threadId ? state.streamingProjectId : null;

              const remainingInterruptResponses = clearInterruptResponsesByPrefix(
                state.interruptResponses,
                `${threadId}\u0000${turnId}\u0000`,
              );

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
                ...(remainingInterruptResponses
                  ? { interruptResponses: remainingInterruptResponses }
                  : {}),
              };
            });

            if (threadListPatch) {
              threadCache.patchThread(threadId, threadListPatch);
            }

            if (!shouldInvalidateSnapshot) return;
            // Cache side effects stay outside Zustand's `set()` call: the terminal
            // reducer path writes store state first, then asks the cache to catch
            // projector-only fields such as final usage/cost metadata. The port
            // owns the render-safe deferral.
            threadCache.invalidateThread(threadId, terminalProjectId);
          },

          dispatchRunState(threadId, action) {
            set((state) => {
              const slice = state.runStateByThread[threadId] ?? INITIAL_RUN_STATE_SLICE;
              const next = reduceRunState(slice, action);
              return next === slice
                ? state
                : { runStateByThread: { ...state.runStateByThread, [threadId]: next } };
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

          applyTurnEvent(threadId, event, seq) {
            reducer.applyEvent(threadId, event, seq);
          },

          removeTurns(threadId, ids, seq) {
            set((state) => {
              const next = removeTurnsIn(
                {
                  turns: state.turnsByThread[threadId] ?? [],
                  tombstones: state.tombstonesByThread[threadId] ?? new Map(),
                },
                ids,
                seq,
              );
              return {
                turnsByThread: { ...state.turnsByThread, [threadId]: next.turns },
                tombstonesByThread: { ...state.tombstonesByThread, [threadId]: next.tombstones },
              };
            });
          },

          applyDurableBlockEvent(threadId, event) {
            return reducer.applyDurableBlockEvent(threadId, event);
          },

          acceptDurableBlockSeq(threadId, seq) {
            if (parseSeq(seq) === null) return false;
            const state = get();
            const cursor = state.durableBlockCursorByThread[threadId];
            if (cursor !== undefined && compareSeq(seq, cursor) <= 0) return false;
            const nextFloor = (BigInt(seq) + 1n).toString();
            const floor = state.snapshotNextSeqFloorByThread[threadId];
            set({
              durableBlockCursorByThread: {
                ...state.durableBlockCursorByThread,
                [threadId]: seq,
              },
              snapshotNextSeqFloorByThread: {
                ...state.snapshotNextSeqFloorByThread,
                [threadId]: floor && compareSeq(floor, nextFloor) > 0 ? floor : nextFloor,
              },
            });
            return true;
          },

          acceptsThreadSnapshot(threadId, nextSeq) {
            if (parseSeq(nextSeq) === null) return false;
            const floor = get().snapshotNextSeqFloorByThread[threadId];
            return floor === undefined || compareSeq(nextSeq, floor) >= 0;
          },

          applyThreadSnapshot(thread, serverTurns, options) {
            const threadId = thread.id;
            const { nextSeq, lifecycle } = options;
            if (!get().acceptsThreadSnapshot(threadId, nextSeq)) return false;
            threadCache.upsertThread(thread, lifecycle);
            reducer.clearPendingInterruptPatchesForThread(threadId);
            set((state) => {
              const localTurns = state.turnsByThread[threadId] ?? [];
              const runningTurnId = lifecycle.runningTurnId;
              const applied = applySnapshotTo(
                state.tombstonesByThread[threadId] ?? new Map(),
                serverTurns,
                nextSeq,
              );
              const mergedTurns = reconcileSnapshotTurns(localTurns, applied.turns, {
                runningTurnId,
              });

              const nextState: Partial<ThreadStoreSliceState> = {
                turnsByThread: { ...state.turnsByThread, [threadId]: mergedTurns },
                tombstonesByThread: { ...state.tombstonesByThread, [threadId]: applied.tombstones },
              };

              const reconciledInterruptResponses = reconcileInterruptResponsesForThread(
                state.interruptResponses,
                threadId,
                mergedTurns,
              );
              if (reconciledInterruptResponses) {
                nextState.interruptResponses = reconciledInterruptResponses;
              }

              const coveredSeq = (BigInt(nextSeq) - 1n).toString();
              const priorCursor = state.durableBlockCursorByThread[threadId];
              if (
                BigInt(nextSeq) > 0n &&
                (!priorCursor || compareSeq(coveredSeq, priorCursor) > 0)
              ) {
                nextState.durableBlockCursorByThread = {
                  ...state.durableBlockCursorByThread,
                  [threadId]: coveredSeq,
                };
              }

              nextState.snapshotNextSeqFloorByThread = {
                ...state.snapshotNextSeqFloorByThread,
                [threadId]: nextSeq,
              };

              const meta = liveMetaFor(state.liveMeta, threadId);
              nextState.liveMeta = {
                ...state.liveMeta,
                [threadId]: {
                  ...meta,
                  runningTurnId,
                },
              };

              return nextState;
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
  return useThreadStore((state) => state.runStateByThread[threadId] ?? INITIAL_RUN_STATE_SLICE);
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
