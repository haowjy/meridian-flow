/** Coordinates response-scoped process-local state with the database transaction outcome. */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  deferUntilDrizzleCommit,
  deferUntilDrizzleRollback,
} from "../../../shared/drizzle-transaction.js";

export interface ResponseCommitParticipant {
  commit(): void | Promise<void>;
  abort(): void | Promise<void>;
  /** Best-effort reconciliation for a finalizer that failed after durability. */
  onCommitFailure?(cause: unknown): void | Promise<void>;
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
    for (const participant of transaction.participants) {
      try {
        await participant.commit();
      } catch (cause) {
        console.error("Response participant failed after durable commit", {
          responseTransactionId: transaction.id,
          cause,
        });
        try {
          await participant.onCommitFailure?.(cause);
        } catch (reconciliationCause) {
          console.error("Response participant reconciliation failed", {
            responseTransactionId: transaction.id,
            cause: reconciliationCause,
          });
        }
      }
    }
  };
  const abortAll = async () => {
    if (transaction.settled) return;
    transaction.settled = true;
    const abortErrors: unknown[] = [];
    for (const participant of [...transaction.participants].reverse()) {
      try {
        await participant.abort();
      } catch (abortCause) {
        abortErrors.push(abortCause);
      }
    }
    if (abortErrors.length === 1) throw abortErrors[0];
    if (abortErrors.length > 1) {
      throw new AggregateError(abortErrors, "Response participant aborts failed");
    }
  };
  try {
    let commitDeferred = false;
    const result = await responseTransactionStorage.run(transaction, () =>
      atomic(async () => {
        commitDeferred = deferUntilDrizzleCommit(commitAll);
        const abortDeferred = deferUntilDrizzleRollback(abortAll);
        if (commitDeferred !== abortDeferred) {
          throw new Error("Drizzle transaction exposes only one response settlement direction");
        }
        return operation();
      }),
    );
    if (!commitDeferred) await commitAll();
    return result;
  } catch (cause) {
    if (!transaction.settled) {
      try {
        await abortAll();
      } catch (abortCause) {
        throw new AggregateError([cause, abortCause], "Response transaction and abort failed");
      }
    }
    throw cause;
  }
}
