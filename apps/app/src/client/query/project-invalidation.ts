/**
 * project-invalidation — invalidates a project's thread + works React Query
 * caches together so dependent views refetch after a mutation. One small
 * coordination helper; query keys live in `project-query-keys`.
 */
import type { QueryClient } from "@tanstack/react-query";

import { projectQueryKeys } from "./project-query-keys";

export async function invalidateProjectThreadData(
  client: QueryClient,
  projectId: string,
): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId) }),
    client.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) }),
  ]);
}
