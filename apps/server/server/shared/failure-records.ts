import type { FailureRecord } from "@meridian/contracts/failures";
import {
  type DrizzleTransactionParticipant,
  enlistDrizzleTransactionParticipant,
  isInDrizzleTransaction,
  runAfterDrizzleCommit,
} from "./drizzle-transaction.js";
import type { InMemoryTransactionOwner } from "./in-memory-transaction.js";

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
    runAfterDrizzleCommit(() => {
      for (const { record, emit } of batch) emit(record);
    });
  },
};

export function recordFailureAfterCommit(
  record: FailureRecord,
  emit: (record: FailureRecord) => void,
  inMemoryOwner?: InMemoryTransactionOwner,
): void {
  if (!isInDrizzleTransaction()) {
    if (!inMemoryOwner?.afterCommit(() => emit(record))) emit(record);
    return;
  }
  const state = enlistDrizzleTransactionParticipant(participant);
  const key = `${record.occurrenceId}:${record.phase}`;
  if (!state.pending.has(key)) state.pending.set(key, { record, emit });
}
