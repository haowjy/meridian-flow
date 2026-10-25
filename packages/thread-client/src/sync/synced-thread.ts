/**
 * `SyncedThread`: the one plain value a host holds per chat (turns, the fences that keep old
 * reads and removed turns out, the snapshot floor, the durable-block cursor, the reducer's event
 * counter and the run-state slice), and the pure transitions that change it. The app keeps the
 * value in its Zustand store; `syncedTurnStore` is the one `TurnStore` the reducer writes through,
 * over a host-provided cell for that value. Nothing here fetches, subscribes or schedules.
 *
 * The four positions of the sync KB decision stay apart: the floor (a read applies only at or
 * above it), `resumeAfterSeq` (read from each read, never stored), the durable cursor and the
 * delivery cursor (the highest frame the stream wrote here).
 */

import type { FailureOccurrence } from "@meridian/contracts/failures";
import type { Block } from "@meridian/contracts/protocol";
import { compareSeq, parseSeq, type Turn, type TurnStatus } from "@meridian/contracts/protocol";
import type { RunState } from "@meridian/contracts/threads";
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
  /** Turns removed from the conversation, until a read covering the removal arrives. */
  tombstones: Tombstones;
  /** Dividers a `switched` frame added that no applied read covers yet. */
  dividers: HeldDividers;
  /** Every id a `turns.forgotten` frame named, held or not. Never pruned. */
  forgotten: ForgottenStamps;
  /** Snapshot freshness: a read applies only at or above it. Rises only, except by an applied read. */
  floor: string | null;
  /** The last durable block applied. */
  durableCursor: string | null;
  /**
   * The highest frame seq the stream has written into the value. A sync joins above it, so a kept
   * value's stream-built blocks are never delivered twice. It only rises; a read leaves it alone.
   */
  deliveryCursor: string | null;
  /** The reducer's event counter; it names fallback block ids, so it never resets. */
  eventsApplied: number;
  runState: RunStateSlice;
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
};

/** The facts of one applied read: its turns, and its record, which reaches the slice as `history`. */
export type ReadFacts = {
  turns: Turn[];
  nextSeq: string;
  /** The assistant turn the server says is still running, even before the read's turns hold it. */
  runningTurnId: string | null;
  /** The read's record: it agrees with the turns, so both change in one transition. */
  runState: RunState;
};

/** Whether a read at `nextSeq` may apply: it is not older than what the chat already took. */
export function acceptsSnapshot(synced: SyncedThread, nextSeq: string): boolean {
  if (parseSeq(nextSeq) === null) return false;
  return synced.floor === null || compareSeq(nextSeq, synced.floor) >= 0;
}

/** Raise the delivery cursor to `seq`. The value itself when `seq` is malformed or not above it. */
export function raiseDeliveryCursor(synced: SyncedThread, seq: string): SyncedThread {
  if (parseSeq(seq) === null) return synced;
  if (synced.deliveryCursor !== null && compareSeq(seq, synced.deliveryCursor) <= 0) return synced;
  return { ...synced, deliveryCursor: seq };
}

/**
 * Apply a read: server turns are the spine (`applySnapshotTo`, then `reconcileSnapshotTurns`), the
 * durable cursor moves to what the read covers, and the floor to its `nextSeq`. Null when the
 * read is stale; the value is then unchanged.
 */
export function applyRead(synced: SyncedThread, read: ReadFacts): SyncedThread | null {
  const { nextSeq } = read;
  if (!acceptsSnapshot(synced, nextSeq)) return null;
  const applied = applySnapshotTo(synced, read.turns, nextSeq);
  const turns = reconcileSnapshotTurns(synced.turns, applied.turns, {
    runningTurnId: read.runningTurnId,
  });
  // A row still waiting on its admission answer is an identity bridge: the answer may name a
  // turn another tab handed back. Covered tombstones stay until it settles.
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
  };
}

/**
 * Whether the stream named a fact only a read can bring: a held divider waits for its anchor
 * turn, or the record names a waiting writer message the transcript lacks. Asked when a
 * refresh timer fires, so this device's own message, acknowledged meanwhile, is no gap.
 */
export function missing(synced: SyncedThread): boolean {
  if (dividersAwaitingAnchorIn(synced).length > 0) return true;
  const { record } = synced.runState.view;
  if (!record) return false;
  const held = new Set(synced.turns.map((turn) => turn.id));
  return unheldWriterMessages(record, (id) => held.has(id)).length > 0;
}

/** Admit a durable block's wire sequence: the cursor and the floor rise past it. Null when it is old or malformed. */
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

export function receiveRunState(synced: SyncedThread, action: RunStateAction): SyncedThread {
  const runState = reduceRunState(synced.runState, action);
  return runState === synced.runState ? synced : { ...synced, runState };
}

export function appendLocalUserTurn(synced: SyncedThread, turn: Turn): SyncedThread {
  return { ...synced, turns: [...synced.turns, turn] };
}

/**
 * The admission answer is the explicit bridge from a local `turn_local_*` row to the persisted
 * user turn: the row takes the server id and settles. The floor rises either way, since the
 * server stated it. When another tab handed the message back first, the row goes instead of
 * becoming the turn that left the conversation.
 */
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

/** Remove turns that left the conversation, keeping a tombstone at `seq` (see `removeTurnsIn`). */
export function removeTurns(
  synced: SyncedThread,
  ids: readonly string[],
  seq: string,
): SyncedThread {
  const next = removeTurnsIn(synced, ids, seq);
  return { ...synced, turns: next.turns, tombstones: next.tombstones };
}

/** Stamp failed turns that left the conversation, remembering every id (see `markForgottenIn`). */
export function markForgotten(
  synced: SyncedThread,
  ids: readonly string[],
  byTurnId: string,
): SyncedThread {
  const next = markForgottenIn(synced, ids, byTurnId);
  return { ...synced, turns: next.turns, forgotten: next.forgotten };
}

/**
 * Drop an orphaned transport tail. Submit-time pruning runs after the controller tore down its
 * live subscription; only a streaming assistant row can be one, since pending rows and waiting
 * interrupts are authoritative server state.
 */
export function pruneStreamingTail(synced: SyncedThread): SyncedThread {
  const turns = synced.turns.filter(
    (turn) => !(turn.role === "assistant" && turn.status === "streaming"),
  );
  return turns.length === synced.turns.length ? synced : { ...synced, turns };
}

/** The host's cell for one chat's value. `get` is undefined until something wrote the chat. */
export type SyncedCell = {
  get(threadId: string): SyncedThread | undefined;
  set(threadId: string, next: SyncedThread): void;
};

export type SyncedTurnStoreOptions = {
  cell: SyncedCell;
  /** ISO time for rows the store creates. */
  now: () => string;
  /** An assistant turn was ensured (created or already held). */
  onTurnEnsured?(threadId: string, turnId: string): void;
  /** A held turn's status was written; `before` is the turn as it was. */
  onStatusPatched?(threadId: string, turnId: string, status: TurnStatus, before: Turn): void;
  invalidateThreadSnapshot?(threadId: string): void;
  settleInterruptResponse?(identity: {
    threadId: string;
    turnId: string;
    interruptId: string;
  }): void;
};

/**
 * The one `TurnStore` the reducer writes through. Each operation reads the cell's current value
 * and writes the next before it returns, because the reducer re-reads after its writes. The
 * callbacks are the host's side effects; they run after the write, never inside it.
 */
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

    bumpEventsApplied(threadId) {
      const synced = read(threadId);
      const eventsApplied = synced.eventsApplied + 1;
      write(threadId, { ...synced, eventsApplied });
      return eventsApplied;
    },

    settleInterruptResponse: (identity) => options.settleInterruptResponse?.(identity),
  };
}
