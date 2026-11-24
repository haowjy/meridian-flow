import type { FailureOccurrence } from "@meridian/contracts/failures";
import type { Block } from "@meridian/contracts/protocol";
import { compareSeq, parseSeq, type Turn, type TurnStatus } from "@meridian/contracts/protocol";
import type { RunState, ThreadAsk } from "@meridian/contracts/threads";
import { type ChatAsks, EMPTY_CHAT_ASKS, receiveAsks } from "../asks/asks";
import { unheldWriterMessages } from "../run-state/fold-messages";
import {
  INITIAL_RUN_STATE_SLICE,
  type RunStateAction,
  type RunStateSlice,
  reduceRunState,
} from "../run-state/run-state-slice";
import { reconcileSnapshotTurns } from "../turns/reconcile-snapshot-turns";
import type { TurnStore } from "../turns/reduce-turn-event";
import {
  applySnapshotTo,
  dividersAwaitingAnchorIn,
  type EnsureAssistantTurnOptions,
  ensureAssistantTurnIn,
  ensureSwitchTurnIn,
  type ForgottenStamps,
  type HeldDividers,
  markForgottenIn,
  patchTurnStatusIn,
  removeTurnsIn,
  type SwitchTurnFacts,
  type Tombstones,
  type TurnStatusPatch,
  upsertBlockIn,
} from "../turns/turn-ops";
import { isOptimisticTurnId } from "../view/optimistic-turn-id";

export type SyncedThread = {
  unavailable: FailureOccurrence | null;
  turns: Turn[];
  tombstones: Tombstones;
  dividers: HeldDividers;
  forgotten: ForgottenStamps;
  floor: string | null;
  durableCursor: string | null;
  deliveryCursor: string | null;
  eventsApplied: number;
  runState: RunStateSlice;
  asks: ChatAsks;
};

export const EMPTY_SYNCED_THREAD: SyncedThread = {
  unavailable: null,
  turns: [],
  tombstones: new Map(),
  dividers: new Map(),
  forgotten: new Map(),
  floor: null,
  durableCursor: null,
  deliveryCursor: null,
  eventsApplied: 0,
  runState: INITIAL_RUN_STATE_SLICE,
  asks: EMPTY_CHAT_ASKS,
};

export type ReadFacts = {
  turns: Turn[];
  asks: readonly ThreadAsk[];
  nextSeq: string;
  runningTurnId: string | null;
  runState: RunState;
};

export function acceptsSnapshot(synced: SyncedThread, nextSeq: string): boolean {
  if (parseSeq(nextSeq) === null) return false;
  return synced.floor === null || compareSeq(nextSeq, synced.floor) >= 0;
}

export function raiseDeliveryCursor(synced: SyncedThread, seq: string): SyncedThread {
  if (parseSeq(seq) === null) return synced;
  if (synced.deliveryCursor !== null && compareSeq(seq, synced.deliveryCursor) <= 0) return synced;
  return { ...synced, deliveryCursor: seq };
}

export function applyRead(synced: SyncedThread, read: ReadFacts): SyncedThread | null {
  const { nextSeq } = read;
  if (!acceptsSnapshot(synced, nextSeq)) return null;
  const applied = applySnapshotTo(synced, read.turns, nextSeq);
  const turns = reconcileSnapshotTurns(synced.turns, applied.turns, {
    runningTurnId: read.runningTurnId,
  });
  const awaitingAdmission = synced.turns.some((turn) => isOptimisticTurnId(turn.id));
  const coveredSeq = (BigInt(nextSeq) - 1n).toString();
  const durableCursor =
    BigInt(nextSeq) > 0n &&
    (synced.durableCursor === null || compareSeq(coveredSeq, synced.durableCursor) > 0)
      ? coveredSeq
      : synced.durableCursor;
  return {
    ...synced,
    turns,
    tombstones: awaitingAdmission ? synced.tombstones : applied.tombstones,
    dividers: applied.dividers,
    floor: nextSeq,
    durableCursor,
    runState: reduceRunState(synced.runState, { type: "history", runState: read.runState }),
    asks: receiveAsks(synced.asks, read.asks),
  };
}

export function missing(synced: SyncedThread): boolean {
  if (dividersAwaitingAnchorIn(synced).length > 0) return true;
  const { record } = synced.runState.view;
  if (!record) return false;
  const held = new Set(synced.turns.map((turn) => turn.id));
  return unheldWriterMessages(record, (id) => held.has(id)).length > 0;
}

export function acceptDurableBlockSeq(synced: SyncedThread, seq: string): SyncedThread | null {
  if (parseSeq(seq) === null) return null;
  if (synced.durableCursor !== null && compareSeq(seq, synced.durableCursor) <= 0) return null;
  const nextFloor = (BigInt(seq) + 1n).toString();
  return {
    ...synced,
    durableCursor: seq,
    floor: synced.floor && compareSeq(synced.floor, nextFloor) > 0 ? synced.floor : nextFloor,
  };
}

export function updateAsks(
  synced: SyncedThread,
  change: (asks: ChatAsks) => ChatAsks,
): SyncedThread {
  const asks = change(synced.asks);
  return asks === synced.asks ? synced : { ...synced, asks };
}

export function receiveRunState(synced: SyncedThread, action: RunStateAction): SyncedThread {
  const runState = reduceRunState(synced.runState, action);
  return runState === synced.runState ? synced : { ...synced, runState };
}

export function appendLocalUserTurn(synced: SyncedThread, turn: Turn): SyncedThread {
  return { ...synced, turns: [...synced.turns, turn] };
}

export function acknowledgeAdmission(
  synced: SyncedThread,
  optimisticTurnId: string,
  serverTurnId: string,
  snapshotFloorNextSeq: string,
  completedAt: string,
): SyncedThread {
  const raised =
    synced.floor === null || BigInt(snapshotFloorNextSeq) > BigInt(synced.floor)
      ? { ...synced, floor: BigInt(snapshotFloorNextSeq).toString() }
      : synced;
  if (optimisticTurnId === serverTurnId || !isOptimisticTurnId(optimisticTurnId)) return raised;
  const { turns } = raised;
  const optimisticTurn = turns.find((turn) => turn.id === optimisticTurnId);
  if (optimisticTurn?.role !== "user") return raised;

  const handedBack = raised.tombstones.has(serverTurnId);
  const hasServerTurn = handedBack || turns.some((turn) => turn.id === serverTurnId);
  const nextTurns = turns
    .filter((turn) => !(hasServerTurn && turn.id === optimisticTurnId))
    .map((turn) => {
      if (turn.id === optimisticTurnId) {
        return {
          ...turn,
          id: serverTurnId,
          status: "complete" as const,
          completedAt: turn.completedAt ?? completedAt,
          blocks: turn.blocks.map((block) => ({ ...block, turnId: serverTurnId })),
        };
      }
      if (turn.prevTurnId === optimisticTurnId) return { ...turn, prevTurnId: serverTurnId };
      return turn;
    });
  return { ...raised, turns: nextTurns };
}

export function removeLocalUserTurn(synced: SyncedThread, turnId: string): SyncedThread {
  const turns = synced.turns.filter((turn) => turn.id !== turnId);
  return turns.length === synced.turns.length ? synced : { ...synced, turns };
}

export function patchTurnStatus(
  synced: SyncedThread,
  turnId: string,
  status: TurnStatus,
  patch?: TurnStatusPatch,
): SyncedThread {
  const turns = patchTurnStatusIn(synced.turns, turnId, status, patch);
  return turns ? { ...synced, turns } : synced;
}

export function removeTurns(
  synced: SyncedThread,
  ids: readonly string[],
  seq: string,
): SyncedThread {
  const next = removeTurnsIn(synced, ids, seq);
  return { ...synced, turns: next.turns, tombstones: next.tombstones };
}

export function markForgotten(
  synced: SyncedThread,
  ids: readonly string[],
  byTurnId: string,
): SyncedThread {
  const next = markForgottenIn(synced, ids, byTurnId);
  return { ...synced, turns: next.turns, forgotten: next.forgotten };
}

export function pruneStreamingTail(synced: SyncedThread): SyncedThread {
  const turns = synced.turns.filter(
    (turn) => !(turn.role === "assistant" && turn.status === "streaming"),
  );
  return turns.length === synced.turns.length ? synced : { ...synced, turns };
}

export type SyncedCell = {
  get(threadId: string): SyncedThread | undefined;
  set(threadId: string, next: SyncedThread): void;
};

export type SyncedTurnStoreOptions = {
  cell: SyncedCell;
  now: () => string;
  onTurnEnsured?(threadId: string, turnId: string): void;
  onStatusPatched?(threadId: string, turnId: string, status: TurnStatus, before: Turn): void;
  invalidateThreadSnapshot?(threadId: string): void;
};

export function syncedTurnStore(options: SyncedTurnStoreOptions): TurnStore {
  const { cell, now } = options;
  const read = (threadId: string) => cell.get(threadId) ?? EMPTY_SYNCED_THREAD;
  const write = (threadId: string, next: SyncedThread) => {
    if (next !== read(threadId)) cell.set(threadId, next);
  };
  return {
    turns: (threadId) => cell.get(threadId)?.turns,

    ensureAssistantTurn(threadId: string, turnId: string, opts?: EnsureAssistantTurnOptions) {
      const synced = read(threadId);
      const result = ensureAssistantTurnIn(synced.turns, threadId, turnId, now(), opts);
      if (result.kind === "rejected") return;
      if (result.turns !== synced.turns) write(threadId, { ...synced, turns: result.turns });
      options.onTurnEnsured?.(threadId, turnId);
    },

    ensureSwitchTurn(threadId: string, facts: SwitchTurnFacts, seq: string) {
      const synced = read(threadId);
      const held = { turns: synced.turns, dividers: synced.dividers };
      const next = ensureSwitchTurnIn(held, threadId, facts, seq, now());
      if (next === held) return;
      write(threadId, { ...synced, turns: next.turns, dividers: next.dividers });
    },

    upsertAssistantBlock(threadId: string, turnId: string, block: Block) {
      const synced = read(threadId);
      const turns = upsertBlockIn(synced.turns, turnId, block);
      if (turns) write(threadId, { ...synced, turns });
    },

    invalidateThreadSnapshot: options.invalidateThreadSnapshot,

    patchTurnStatus(threadId, turnId, status, patch) {
      const synced = read(threadId);
      const before = synced.turns.find((turn) => turn.id === turnId);
      if (!before) return;
      write(threadId, patchTurnStatus(synced, turnId, status, patch));
      options.onStatusPatched?.(threadId, turnId, status, before);
    },

    removeTurns(threadId, ids, seq) {
      write(threadId, removeTurns(read(threadId), ids, seq));
    },

    markForgotten(threadId, ids, byTurnId) {
      write(threadId, markForgotten(read(threadId), ids, byTurnId));
    },

    receiveAsk(threadId, ask) {
      write(
        threadId,
        updateAsks(read(threadId), (asks) => receiveAsks(asks, [ask])),
      );
    },

    bumpEventsApplied(threadId) {
      const synced = read(threadId);
      const eventsApplied = synced.eventsApplied + 1;
      write(threadId, { ...synced, eventsApplied });
      return eventsApplied;
    },
  };
}
