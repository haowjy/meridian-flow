import type { Query } from "@tanstack/react-query";

import { readPendingProjectCreation } from "./project-commands";
import { projectIdOfQueryKey } from "./project-query-keys";

export function isProjectReadPaused(queryKey: readonly unknown[]): boolean {
  const projectId = projectIdOfQueryKey(queryKey);
  return projectId !== null && readPendingProjectCreation(projectId) !== undefined;
}

export function projectReadEnabled(callerEnabled = true) {
  // biome-ignore lint/suspicious/noExplicitAny: TanStack's `enabled` takes the query's own types, which are invariant. slop-lint: allow suppression the reason is stated in this comment
  return (query: Query<any, any, any, any>) =>
    callerEnabled && !isProjectReadPaused(query.queryKey);
}
