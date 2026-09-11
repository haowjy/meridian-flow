import type { ContextScheme } from "./context-port.js";

export type ContextCommandScope = { scheme: ContextScheme; workId: string | null };

/** Transaction boundary for one result-returning Context command. */
export interface ContextCommandTransaction {
  run<T>(operation: () => Promise<T>, scopes?: readonly ContextCommandScope[]): Promise<T>;
}

export const directContextCommandTransaction: ContextCommandTransaction = {
  run: (operation) => operation(),
};
