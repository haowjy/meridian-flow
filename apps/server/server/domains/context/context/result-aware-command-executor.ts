/** Transactional execution for commands whose domain failures are returned as Results. */
import { Err, type Result } from "../../../shared/result.js";
import type { ContextCommandTransaction } from "../ports/context-command-transaction.js";

export interface ResultAwareCommandExecutor<TError> {
  run<T>(operation: () => Promise<Result<T, TError>>): Promise<Result<T, TError>>;
}

class ResultRollback<TError> extends Error {
  constructor(readonly error: TError) {
    super("Result-aware command returned an error");
  }
}

export function createResultAwareCommandExecutor<TError>(input: {
  transaction: ContextCommandTransaction;
  serializeThroughCallbacks: boolean;
}): ResultAwareCommandExecutor<TError> {
  let tail = Promise.resolve();

  const execute = async <T>(
    operation: () => Promise<Result<T, TError>>,
  ): Promise<Result<T, TError>> => {
    try {
      return await input.transaction.run(async () => {
        const result = await operation();
        if (!result.ok) throw new ResultRollback(result.error);
        return result;
      });
    } catch (error) {
      if (error instanceof ResultRollback) return Err(error.error as TError);
      throw error;
    }
  };

  return {
    run<T>(operation: () => Promise<Result<T, TError>>): Promise<Result<T, TError>> {
      if (!input.serializeThroughCallbacks) return execute(operation);

      const result = tail.then(() => execute(operation));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
