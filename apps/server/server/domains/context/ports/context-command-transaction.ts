/** Transaction boundary for one result-returning Context command. */
export interface ContextCommandTransaction {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export const directContextCommandTransaction: ContextCommandTransaction = {
  run: (operation) => operation(),
};
