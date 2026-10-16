/**
 * The failure-record transaction participant: collects `FailureRecord`s a transaction detects and emits
 * them only after the outermost commit. A savepoint that rolls back discards its records, and a record
 * detected twice in one transaction (same occurrence and phase) emits once. It is its own participant,
 * not part of `run_state.changed`: a failure can happen without a run-state change, and chat never
 * coalesces it. The in-memory repositories' transaction defers the same way; outside any transaction
 * there is no commit to wait for, so a record emits at once.
 */
import type { FailureRecord } from "@meridian/contracts/failures";
import {
  type DrizzleTransactionParticipant,
  deferUntilDrizzleCommit,
  enlistDrizzleTransactionParticipant,
  isInDrizzleTransaction,
} from "./drizzle-transaction.js";
import { deferUntilInMemoryCommit } from "./in-memory-transaction.js";

type Pending = { record: FailureRecord; emit: (record: FailureRecord) => void };
type FailureState = { pending: Map<string, Pending> };

const FAILURE_KEY = {};

const participant: DrizzleTransactionParticipant<FailureState> = {
  key: FAILURE_KEY,
  create: () => ({ pending: new Map() }),
  fork: (parent) => ({ pending: new Map(parent.pending) }),
  merge: (_parent, child) => child,
  async beforeCommit(state) {
    if (state.pending.size === 0) return;
    const batch = [...state.pending.values()];
    state.pending.clear();
    deferUntilDrizzleCommit(() => {
      for (const { record, emit } of batch) emit(record);
    });
  },
};

/** Queues `record` for emission after the outermost commit, or emits it at once outside a transaction. */
export function recordFailureAfterCommit(
  record: FailureRecord,
  emit: (record: FailureRecord) => void,
): void {
  if (!isInDrizzleTransaction()) {
    if (!deferUntilInMemoryCommit(() => emit(record))) emit(record);
    return;
  }
  const state = enlistDrizzleTransactionParticipant(participant);
  const key = `${record.occurrenceId}:${record.phase}`;
  if (!state.pending.has(key)) state.pending.set(key, { record, emit });
}
