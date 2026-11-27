import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "@meridian/database";
import { processDetachedWork } from "./detached-work.js";
import { runOutsideEditConfirmation } from "./edit-confirmation.js";

export type DrizzleDatabase = Database;
export type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
export type DrizzleDb = DrizzleDatabase | DrizzleTransaction;

type DrizzleTransactionContext = {
  db: DrizzleDb;
  afterCommit: Array<() => void | Promise<void>>;
  afterRollback: Array<() => void | Promise<void>>;
  locals: Map<object, unknown>;
  participants: Map<object, ParticipantFrame<unknown>>;
  flushingParticipants: boolean;
  closed: boolean;
};

export type DrizzleTransactionParticipant<State> = {
  key: object;
  create(): State;
  fork(parent: State): State;
  merge(parent: State, child: State): State;
  beforeCommit?(state: State): Promise<void>;
};

type ParticipantFrame<State> = {
  participant: DrizzleTransactionParticipant<State>;
  state: State;
};

const transactionStorage = new AsyncLocalStorage<DrizzleTransactionContext>();

// Async work inherits the ambient transaction, so a branch still running after its scope ends reaches a finished transaction; it throws instead of using the released connection
function activeTransaction(): DrizzleTransactionContext | undefined {
  const active = transactionStorage.getStore();
  if (active?.closed) {
    throw new Error("Database work ran after its transaction ended");
  }
  return active;
}

function runAsTransactionBody<T>(
  context: DrizzleTransactionContext,
  operation: () => Promise<T>,
): Promise<T> {
  return transactionStorage.run(context, async () => {
    try {
      return await operation();
    } finally {
      context.closed = true;
    }
  });
}

function newTransactionContext(db: DrizzleDb): DrizzleTransactionContext {
  return {
    db,
    afterCommit: [],
    afterRollback: [],
    locals: new Map(),
    participants: new Map(),
    flushingParticipants: false,
    closed: false,
  };
}

export function currentDrizzleDb(db: DrizzleDb): DrizzleDb {
  const active = activeTransaction();
  if (active) return active.db;
  assertOutsideCommandTransaction("A second connection");
  return db;
}

export async function runInDrizzleTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  if (activeTransaction()) return operation();
  assertOutsideCommandTransaction("A second connection");
  const context = newTransactionContext(db);
  let result: T;
  try {
    result = await db.transaction((tx) => {
      context.db = tx;
      return runAsTransactionBody(context, async () => {
        const result = await operation();
        await flushDrizzleTransactionParticipants(context);
        return result;
      });
    });
  } catch (cause) {
    await dispatchAfterRollback(context.afterRollback, cause);
    throw cause;
  }
  await dispatchAfterCommit(context.afterCommit);
  return result;
}

const joinsRoots = { name: "joins-roots" };

const commandStorage = new AsyncLocalStorage<DrizzleTransactionContext>();

const COMMAND_CHECKS = process.env.NODE_ENV !== "production";

export async function runInCommandTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  if (activeTransaction())
    throw new Error("A command opens its own transaction; it cannot join one");
  return runInDrizzleTransaction(db, () => {
    const context = activeTransaction() as DrizzleTransactionContext;
    context.locals.set(joinsRoots, true);
    return commandStorage.run(context, operation);
  });
}

export function assertOutsideCommandTransaction(what: string): void {
  if (!COMMAND_CHECKS) return;
  const command = commandStorage.getStore();
  if (command && !command.closed) throw new Error(`${what} inside a command transaction`);
}

export async function runInRootDrizzleTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
  options?: { isolationLevel?: "repeatable read"; accessMode?: "read only" },
): Promise<T> {
  if (getDrizzleTransactionLocal<boolean>(joinsRoots)) return operation();
  assertOutsideCommandTransaction("A second connection");
  return transactionStorage.exit(async () => {
    const context = newTransactionContext(db);
    let result: T;
    try {
      result = await db.transaction((tx) => {
        context.db = tx;
        return runAsTransactionBody(context, async () => {
          const result = await operation();
          await flushDrizzleTransactionParticipants(context);
          return result;
        });
      }, options);
    } catch (cause) {
      await dispatchAfterRollback(context.afterRollback, cause);
      throw cause;
    }
    await dispatchAfterCommit(context.afterCommit);
    return result;
  });
}

export async function runInRootDrizzleReadSnapshot<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  return runInRootDrizzleTransaction(db, operation, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

export async function runInDrizzleSavepoint<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const parent = activeTransaction();
  if (!parent) return runInDrizzleTransaction(db, operation);
  const transactional = parent.db as DrizzleTransaction;
  const child: DrizzleTransactionContext = {
    ...newTransactionContext(transactional),
    locals: new Map(parent.locals),
    participants: new Map(
      [...parent.participants].map(([key, frame]) => [
        key,
        {
          participant: frame.participant,
          state: frame.participant.fork(frame.state),
        },
      ]),
    ),
  };
  try {
    const result = await transactional.transaction((tx) => {
      child.db = tx;
      return runAsTransactionBody(child, operation);
    });
    parent.afterCommit.push(...child.afterCommit);
    parent.afterRollback.push(...child.afterRollback);
    for (const [key, childFrame] of child.participants) {
      const parentFrame = parent.participants.get(key);
      if (parentFrame) {
        parentFrame.state = parentFrame.participant.merge(parentFrame.state, childFrame.state);
      } else {
        const participant = childFrame.participant;
        parent.participants.set(key, {
          participant,
          state: participant.merge(participant.create(), childFrame.state),
        });
      }
    }
    return result;
  } catch (cause) {
    await dispatchAfterRollback(child.afterRollback, cause);
    throw cause;
  }
}

export function runIsolatedFromAmbientTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  return isInDrizzleTransaction() ? runInDrizzleSavepoint(db, operation) : operation();
}

export function enlistDrizzleTransactionParticipant<State>(
  participant: DrizzleTransactionParticipant<State>,
): State {
  const active = activeTransaction();
  if (!active) throw new Error("Drizzle transaction participant requires an ambient transaction");
  const existing = active.participants.get(participant.key) as ParticipantFrame<State> | undefined;
  if (existing) return existing.state;
  if (active.flushingParticipants && participant.beforeCommit) {
    throw new Error("Cannot enlist a before-commit participant while participants are flushing");
  }
  const frame = { participant, state: participant.create() };
  active.participants.set(participant.key, frame as ParticipantFrame<unknown>);
  return frame.state;
}

async function flushDrizzleTransactionParticipants(
  context: DrizzleTransactionContext,
): Promise<void> {
  context.flushingParticipants = true;
  try {
    for (const frame of context.participants.values()) {
      await frame.participant.beforeCommit?.(frame.state);
    }
  } finally {
    context.flushingParticipants = false;
  }
}

export function getDrizzleTransactionLocal<T>(key: object): T | undefined {
  return activeTransaction()?.locals.get(key) as T | undefined;
}

export function setDrizzleTransactionLocal<T>(key: object, value: T): boolean {
  const active = activeTransaction();
  if (!active) return false;
  active.locals.set(key, value);
  return true;
}

export function runAfterDrizzleCommit(callback: () => void | Promise<void>): boolean {
  const active = activeTransaction();
  if (!active) {
    void processDetachedWork
      .track(Promise.resolve(runOutsideWrite(callback)), "after-commit callback")
      .catch((cause) => process.emitWarning(`after-commit callback failed: ${String(cause)}`));
    return false;
  }
  active.afterCommit.push(callback);
  return true;
}

export function deferUntilDrizzleCommit(callback: () => void | Promise<void>): boolean {
  const active = activeTransaction();
  if (!active) return false;
  active.afterCommit.push(callback);
  return true;
}

export function deferUntilDrizzleRollback(callback: () => void | Promise<void>): boolean {
  const active = activeTransaction();
  if (!active) return false;
  active.afterRollback.push(callback);
  return true;
}

export function isRetryableTransactionError(error: unknown): boolean {
  for (let cause = error; cause instanceof Error; cause = cause.cause) {
    const code = (cause as { code?: unknown }).code;
    if (code === "40P01" || code === "40001") return true;
  }
  return false;
}

export function sqlState(cause: unknown): string | null {
  let current: unknown = cause;
  while (current) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

export function isInDrizzleTransaction(): boolean {
  return activeTransaction() !== undefined;
}

export function runOutsideDrizzleTransaction<T>(operation: () => T): T {
  return transactionStorage.exit(operation);
}

export function runOutsideWrite<T>(operation: () => T): T {
  return runOutsideDrizzleTransaction(() => runOutsideEditConfirmation(operation));
}

async function dispatchAfterCommit(callbacks: Array<() => void | Promise<void>>): Promise<void> {
  await Promise.allSettled(
    callbacks.map((callback) => Promise.resolve().then(() => runOutsideWrite(callback))),
  );
}

async function dispatchAfterRollback(
  callbacks: Array<() => void | Promise<void>>,
  transactionCause: unknown,
): Promise<void> {
  const errors: unknown[] = [];
  for (const callback of [...callbacks].reverse()) {
    try {
      await runOutsideDrizzleTransaction(callback);
    } catch (cause) {
      errors.push(cause);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      [transactionCause, ...errors],
      "Drizzle transaction and after-rollback callbacks failed",
    );
  }
}
