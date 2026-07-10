/** Coordinates response-scoped process-local state with the database transaction outcome. */
import { AsyncLocalStorage } from "node:async_hooks";
import { deferUntilDrizzleCommit } from "../../../shared/drizzle-transaction.js";

export interface ResponseCommitParticipant {
  commit(): void | Promise<void>;
  abort(): void | Promise<void>;
}

type ResponseTransactionContext = {
  id: string;
  participants: ResponseCommitParticipant[];
  settled: boolean;
};

const responseTransactionStorage = new AsyncLocalStorage<ResponseTransactionContext>();
let nextTransactionId = 0;

export function currentResponseTransactionId(): string | null {
  return responseTransactionStorage.getStore()?.id ?? null;
}

/** Enlists process-local state when a response transaction is active. */
export function enlistResponseParticipant(participant: ResponseCommitParticipant): boolean {
  const transaction = responseTransactionStorage.getStore();
  if (!transaction) return false;
  if (transaction.settled) throw new Error("Cannot enlist in a settled response transaction");
  transaction.participants.push(participant);
  return true;
}

export async function runResponseTransaction<T>(
  atomic: (operation: () => Promise<T>) => Promise<T>,
  operation: () => Promise<T>,
): Promise<T> {
  const active = responseTransactionStorage.getStore();
  if (active) return operation();

  const transaction: ResponseTransactionContext = {
    id: `response-${++nextTransactionId}`,
    participants: [],
    settled: false,
  };
  const commitAll = async () => {
    if (transaction.settled) return;
    transaction.settled = true;
    const errors: unknown[] = [];
    for (const participant of transaction.participants) {
      try {
        await participant.commit();
      } catch (cause) {
        errors.push(cause);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Response participant commits failed");
  };
  try {
    let commitDeferred = false;
    const result = await responseTransactionStorage.run(transaction, () =>
      atomic(async () => {
        commitDeferred = deferUntilDrizzleCommit(commitAll);
        return operation();
      }),
    );
    if (!commitDeferred) await commitAll();
    return result;
  } catch (cause) {
    if (!transaction.settled) {
      transaction.settled = true;
      const abortErrors: unknown[] = [];
      for (const participant of [...transaction.participants].reverse()) {
        try {
          await participant.abort();
        } catch (abortCause) {
          abortErrors.push(abortCause);
        }
      }
      if (abortErrors.length > 0) {
        throw new AggregateError([cause, ...abortErrors], "Response transaction and abort failed");
      }
    }
    throw cause;
  }
}
