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
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import { devtools } from "zustand/middleware";
import { useShallow } from "zustand/react/shallow";
import {
  type InterruptResponseEntry,
  interruptResponseKey,
} from "@/core/session/interrupt-response";
import {
  clearPendingInterruptPatchesForThread,
  clearPendingInterruptPatchesForTurn,
} from "@/core/session/reduce-turn-event";
import { baseTurnFields } from "@/core/session/state-helpers";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";

import { buildOptimisticUserTurn } from "./build-optimistic-user-turn";
import { isOptimisticTurnId, OPTIMISTIC_TURN_ID_PREFIX } from "./optimistic-turn-id";
import { reconcileSnapshotTurns } from "./reconcile-snapshot-turns";
import { createThreadCache, type ThreadCachePort } from "./thread-cache";
import type {
  EnsureAssistantTurnOptions,
  LiveTurnMeta,
  PendingStreamStart,
  ThreadStoreActions,
  ThreadStoreState,
  TurnStatusPatch,
} from "./types";

type PendingCreationState = {
  projectIds: Record<string, true>;
  threadIds: Record<string, true>;
};

type ThreadStoreSliceState = ThreadStoreState & {
  turnsByThread: Record<string, Turn[]>;
  /** Minimum snapshot nextSeq accepted; snapshots below this floor are rejected. */
  snapshotNextSeqFloorByThread: Record<string, string>;
  durableBlockCursorByThread: Record<string, string>;
  handoffPendingThreadIds: Record<string, true>;
  pendingStreamByThreadId: Record<string, PendingStreamStart>;
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
    writeMode: opts?.writeMode ?? null,
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
    setStreamingThreadId: state.setStreamingThreadId,
    ensureThread: state.ensureThread,
    markHandoffPending: state.markHandoffPending,
    appendUserTurn: state.appendUserTurn,
    acknowledgeUserTurn: state.acknowledgeUserTurn,
    removeOptimisticUserTurn: state.removeOptimisticUserTurn,
    ensureAssistantTurn: state.ensureAssistantTurn,
    upsertAssistantBlock: state.upsertAssistantBlock,
    removeAssistantBlock: state.removeAssistantBlock,
    invalidateThreadSnapshot: state.invalidateThreadSnapshot,
    patchTurnStatus: state.patchTurnStatus,
    pruneStaleAssistantTurns: state.pruneStaleAssistantTurns,
    bumpEventsApplied: state.bumpEventsApplied,
    acceptDurableBlockSeq: state.acceptDurableBlockSeq,
    acceptsThreadSnapshot: state.acceptsThreadSnapshot,
    applyThreadSnapshot: state.applyThreadSnapshot,
    markPendingStream: state.markPendingStream,
    consumePendingStream: state.consumePendingStream,
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
  const { now, threadCache } = config;
  return createStore<ThreadStoreSlice>()(
    devtools(
      (set, get) => ({
        now,
        turnsByThread: {},
        snapshotNextSeqFloorByThread: {},
        durableBlockCursorByThread: {},
        liveMeta: {},
        handoffPendingThreadIds: {},
        pendingStreamByThreadId: {},
        pendingCreation: { projectIds: {}, threadIds: {} },
        interruptResponses: {},
        interruptResponseCounter: 0,
        streamingThreadId: null,
        streamingProjectId: null,
        turnCounter: 0,

        turns(id: string) {
          return get().turnsByThread[id];
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

        acknowledgeUserTurn(threadId, optimisticTurnId, serverTurnId, snapshotFloorNextSeq) {
          if (optimisticTurnId === serverTurnId) return;

          set((state) => {
            if (!isOptimisticTurnId(optimisticTurnId)) return state;

            const turns = state.turnsByThread[threadId] ?? [];
            const optimisticTurn = turns.find((turn) => turn.id === optimisticTurnId);
            if (optimisticTurn?.role !== "user") return state;

            const hasServerTurn = turns.some((turn) => turn.id === serverTurnId);

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
            const existing = state.turnsByThread[threadId] ?? [];
            const existingTurn = existing.find((turn) => turn.id === turnId);
            if (existingTurn) {
              if (existingTurn.role !== "assistant") return state;

              threadListPatch = liveThreadListPatchForTurnStatus(turnId, "streaming");

              const meta = liveMetaFor(state.liveMeta, threadId);
              const nextTurns =
                opts?.writeMode !== undefined && existingTurn.writeMode !== opts.writeMode
                  ? existing.map((turn) =>
                      turn.id === turnId ? { ...turn, writeMode: opts.writeMode ?? null } : turn,
                    )
                  : existing;
              return {
                liveMeta: {
                  ...state.liveMeta,
                  [threadId]: { ...meta, runningTurnId: turnId },
                },
                turnsByThread:
                  nextTurns === existing
                    ? state.turnsByThread
                    : { ...state.turnsByThread, [threadId]: nextTurns },
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
            threadCache.patchThread(threadId, threadListPatch);
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
            const currentBlock = turn.blocks.find(
              (existingBlock) => existingBlock.sequence === block.sequence,
            );
            if (currentBlock && sameBlock(currentBlock, normalizedBlock)) return state;
            const blocks = [
              ...turn.blocks.filter((existingBlock) => existingBlock.sequence !== block.sequence),
              normalizedBlock,
            ].sort((a, b) => a.sequence - b.sequence);

            const nextTurns = turns.map((existingTurn, index) =>
              index === turnIndex ? { ...existingTurn, blocks } : existingTurn,
            );
            const turnsByThread = { ...state.turnsByThread, [threadId]: nextTurns };
            return { turnsByThread };
          });
        },

        removeAssistantBlock(threadId, blockId) {
          set((state) => {
            const turns = state.turnsByThread[threadId];
            if (!turns) return state;
            let changed = false;
            const nextTurns = turns.map((turn) => {
              if (!turn.blocks.some((block) => block.id === blockId)) return turn;
              changed = true;
              return {
                ...turn,
                blocks: turn.blocks.filter((block) => block.id !== blockId),
              };
            });
            if (!changed) return state;
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

            const definedPatch = definedTurnStatusPatch(patch);
            threadListPatch = liveThreadListPatchForTurnStatus(turnId, status);
            const nextTurns = turns.map((turn, index) =>
              index === turnIndex ? { ...turn, ...definedPatch, status } : turn,
            );
            if (!isTerminalTurnStatus(status)) {
              return { turnsByThread: { ...state.turnsByThread, [threadId]: nextTurns } };
            }

            clearPendingInterruptPatchesForTurn(threadId, turnId);
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
          const handoffPending = Boolean(get().handoffPendingThreadIds[threadId]);
          const keepLocalTurns = handoffPending && serverTurns.length === 0;

          threadCache.upsertThread(thread, lifecycle);
          if (!keepLocalTurns) {
            clearPendingInterruptPatchesForThread(threadId);
          }

          set((state) => {
            const handoffPendingThreadIds = { ...state.handoffPendingThreadIds };
            if (!keepLocalTurns) {
              delete handoffPendingThreadIds[threadId];
            }

            if (keepLocalTurns) {
              return {
                handoffPendingThreadIds,
                snapshotNextSeqFloorByThread: {
                  ...state.snapshotNextSeqFloorByThread,
                  [threadId]: nextSeq,
                },
              };
            }

            const localTurns = state.turnsByThread[threadId] ?? [];
            const runningTurnId = lifecycle.runningTurnId;
            const mergedTurns = reconcileSnapshotTurns(localTurns, serverTurns, {
              runningTurnId,
            });

            const nextState: Partial<ThreadStoreSliceState> = {
              handoffPendingThreadIds,
              turnsByThread: { ...state.turnsByThread, [threadId]: mergedTurns },
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
            if (BigInt(nextSeq) > 0n && (!priorCursor || compareSeq(coveredSeq, priorCursor) > 0)) {
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

        markPendingStream(threadId, start) {
          set((state) => ({
            pendingStreamByThreadId: {
              ...state.pendingStreamByThreadId,
              [threadId]: start ?? {},
            },
          }));
        },

        /** One-shot read-and-remove of pending stream metadata. */
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
      }),
      { name: "thread-store", enabled: import.meta.env.DEV },
    ),
  );
}

function sameBlock(left: Block, right: Block): boolean {
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.responseId === right.responseId &&
    left.blockType === right.blockType &&
    left.sequence === right.sequence &&
    left.textContent === right.textContent &&
    left.provider === right.provider &&
    left.executionSide === right.executionSide &&
    left.status === right.status &&
    sameJson(left.content, right.content) &&
    sameJson(left.providerData, right.providerData) &&
    sameJson(left.collapsedContent, right.collapsedContent)
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]),
    )
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
