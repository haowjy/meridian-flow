import type { ContextScheme } from "./context-port.js";

export type ContextCommandScope = { scheme: ContextScheme; workId: string | null };

export type ContextCommandScopes =
  | readonly ContextCommandScope[]
  | (() => Promise<readonly ContextCommandScope[]>);

/** Transaction boundary for one result-returning Context command. */
export interface ContextCommandTransaction {
  run<T>(operation: () => Promise<T>, scopes?: ContextCommandScopes): Promise<T>;
}

export const directContextCommandTransaction: ContextCommandTransaction = {
  async run(operation, scopes) {
    if (typeof scopes === "function") await scopes();
    return operation();
  },
};
