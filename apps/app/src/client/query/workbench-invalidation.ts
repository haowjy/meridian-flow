// @ts-nocheck
/**
 * workbench-invalidation — invalidates a workbench's thread + works React Query
 * caches together so dependent views refetch after a mutation. One small
 * coordination helper; query keys live in `workbench-query-keys`.
 */
import type { QueryClient } from "@tanstack/react-query";

import { workbenchQueryKeys } from "./workbench-query-keys";

export async function invalidateWorkbenchThreadData(
  client: QueryClient,
  workbenchId: string,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: workbenchQueryKeys.threads(workbenchId) }),
    client.invalidateQueries({ queryKey: workbenchQueryKeys.works(workbenchId) }),
  ]);
}
