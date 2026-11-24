import { WorkDeleteRetryError } from "./ports/work-repository.js";

export async function runWorkLifecycleCommand<T>(
  transaction: <R>(operation: () => Promise<R>) => Promise<R>,
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transaction(operation);
    } catch (cause) {
      if (!(cause instanceof WorkDeleteRetryError) || attempt === 4) throw cause;
    }
  }
}
