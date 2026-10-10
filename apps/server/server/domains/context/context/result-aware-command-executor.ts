/** Transactional execution for commands whose domain failures are returned as Results. */
import { Err, type Result } from "../../../shared/result.js";
import type {
  ContextCommandContext,
  ContextCommandOptions,
  ContextCommandScope,
  ContextCommandTransaction,
} from "../ports/context-command-transaction.js";

export interface ResultAwareCommandExecutor<TError> {
  run<T>(
    operation: (command: ContextCommandContext) => Promise<Result<T, TError>>,
    scopes?: readonly ContextCommandScope[],
    options?: ContextCommandOptions,
  ): Promise<Result<T, TError>>;
}

class ResultRollback<TError> extends Error {
  constructor(readonly error: TError) {
    super("Result-aware command returned an error");
  }
}

export function createResultAwareCommandExecutor<TError>(input: {
  transaction: ContextCommandTransaction;
  serializeThroughCallbacks: boolean;
  mapThrownError?: (error: unknown) => TError | undefined;
}): ResultAwareCommandExecutor<TError> {
  let tail = Promise.resolve();

  const execute = async <T>(
    operation: (command: ContextCommandContext) => Promise<Result<T, TError>>,
    scopes?: readonly ContextCommandScope[],
    options?: ContextCommandOptions,
  ): Promise<Result<T, TError>> => {
    try {
      return await input.transaction.run(
        async (command) => {
          const result = await operation(command);
          if (!result.ok) throw new ResultRollback(result.error);
          return result;
        },
        scopes,
        options,
      );
    } catch (error) {
      if (error instanceof ResultRollback) return Err(error.error as TError);
      const mapped = input.mapThrownError?.(error);
      if (mapped !== undefined) return Err(mapped);
      throw error;
    }
  };

  return {
    run<T>(
      operation: (command: ContextCommandContext) => Promise<Result<T, TError>>,
      scopes?: readonly ContextCommandScope[],
      options?: ContextCommandOptions,
    ): Promise<Result<T, TError>> {
      if (!input.serializeThroughCallbacks) return execute(operation, scopes, options);

      const result = tail.then(() => execute(operation, scopes, options));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
