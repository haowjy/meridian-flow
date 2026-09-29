/**
 * Account-scoped state for optimistic, client-addressable Project creation.
 * Its loader short-circuit needs a store outside React; Works are created
 * through the Work command model (`work-command-store`) instead.
 */
import { createStore, useStore } from "zustand";

export type CreationStatus = "pending" | "failed" | "confirmed";

export type CreationRecord<Payload, Result> = {
  key: string;
  payload: Payload;
  result: Result | null;
  status: CreationStatus;
  error: string | null;
};

type CreationRegistryState = {
  accountId: string | null;
  records: Record<string, CreationRecord<unknown, unknown>>;
};

const EMPTY_RECORDS: Record<string, CreationRecord<unknown, unknown>> = {};

export const creationRegistry = createStore<CreationRegistryState>(() => ({
  accountId: null,
  records: EMPTY_RECORDS,
}));

/** A new authenticated account starts with no creations from the previous one. */
export function scopeCreationRegistry(accountId: string): void {
  creationRegistry.setState((state) =>
    state.accountId === accountId ? state : { accountId, records: EMPTY_RECORDS },
  );
}

export function creationRecordKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function readCreationRecord<Payload, Result>(
  key: string,
  accountId?: string,
): CreationRecord<Payload, Result> | undefined {
  const state = creationRegistry.getState();
  if (accountId && state.accountId !== accountId) return undefined;
  return state.records[key] as CreationRecord<Payload, Result> | undefined;
}

export function writeCreationRecord<Payload, Result>(
  accountId: string,
  record: CreationRecord<Payload, Result>,
): void {
  creationRegistry.setState((state) => {
    if (state.accountId !== accountId) return state;
    return {
      ...state,
      records: { ...state.records, [record.key]: record as CreationRecord<unknown, unknown> },
    };
  });
}

export function removeCreationRecord(key: string, accountId?: string): void {
  creationRegistry.setState((state) => {
    if ((accountId && state.accountId !== accountId) || !state.records[key]) return state;
    const records = { ...state.records };
    delete records[key];
    return { ...state, records };
  });
}

export function useCreationRecord<Payload, Result>(
  accountId: string | null,
  key: string,
): CreationRecord<Payload, Result> | undefined {
  return useStore(creationRegistry, (state) =>
    accountId && state.accountId === accountId
      ? (state.records[key] as CreationRecord<Payload, Result> | undefined)
      : undefined,
  );
}

export function useCurrentCreationRecord<Payload, Result>(
  key: string,
): CreationRecord<Payload, Result> | undefined {
  return useStore(creationRegistry, (state) =>
    state.accountId
      ? (state.records[key] as CreationRecord<Payload, Result> | undefined)
      : undefined,
  );
}

export function useCreationRecords(accountId: string | null) {
  return useStore(creationRegistry, (state) =>
    accountId && state.accountId === accountId ? state.records : EMPTY_RECORDS,
  );
}

/** Recover an ambiguous create with its stable identity, preserving the POST error. */
export async function createWithRecovery<Result>(
  create: () => Promise<Result>,
  recover: () => Promise<Result | null>,
): Promise<Result> {
  try {
    return await create();
  } catch (error) {
    try {
      const recovered = await recover();
      if (recovered !== null) return recovered;
    } catch {
      // Preserve the original create error when recovery cannot settle the outcome.
    }
    throw error;
  }
}
