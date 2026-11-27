import type { QueryClient, QueryKey } from "@tanstack/react-query";

// TanStack cancels synchronously, so the write needn't wait for the cancelled reads to settle.
export function writeOverReads<T>(
  client: QueryClient,
  queryKeys: readonly QueryKey[],
  write: () => T,
): T {
  for (const queryKey of queryKeys) void client.cancelQueries({ queryKey, exact: true });
  return write();
}
