/** Transactional execution for commands whose domain failures are returned as Results. */
import { Err, type Result } from "../../../shared/result.js";
import type {
  ContextCommandActiveBranch,
  ContextCommandBranch,
  ContextCommandContext,
  ContextCommandOptions,
  ContextCommandScopes,
  ContextCommandTransaction,
} from "../ports/context-command-transaction.js";

export interface ResultAwareCommandExecutor<TError> {
  run<T>(
    operation: (command: ContextCommandContext) => Promise<Result<T, TError>>,
    scopes?: ContextCommandScopes,
    options?: ContextCommandOptions,
  ): Promise<Result<T, TError>>;
  /** A command in a Work's draft, which the transaction makes (`ensure`) and locks. */
  runInBranch<T>(
    branch: ContextCommandBranch & { mode: "ensure" },
    operation: (branch: ContextCommandActiveBranch) => Promise<Result<T, TError>>,
  ): Promise<Result<T, TError>>;
  /**
   * A read that must hold nothing (a live create's discovery, contract §6.3 step 1), in
   * the same order as this owner's commands but outside any transaction.
   */
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
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
    scopes?: ContextCommandScopes,
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

  function run<T>(
    operation: (command: ContextCommandContext) => Promise<Result<T, TError>>,
    scopes?: ContextCommandScopes,
    options?: ContextCommandOptions,
  ): Promise<Result<T, TError>> {
    if (!input.serializeThroughCallbacks) return execute(operation, scopes, options);

    const result = tail.then(() => execute(operation, scopes, options));
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    run,
    runInBranch(branch, operation) {
      return run(
        ({ branch: active }) => {
          // The transaction contract: an `ensure` command always resolves a draft.
          if (!active) throw new Error("An ensuring command transaction resolved no draft");
          return operation(active);
        },
        undefined,
        { branch },
      );
    },
    exclusive<T>(operation: () => Promise<T>): Promise<T> {
      if (!input.serializeThroughCallbacks) return operation();
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}
