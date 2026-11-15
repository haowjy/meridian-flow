/**
 * Pauses every TanStack query under `["projects", id, ...]` while that
 * project's create is unsettled or refused (the server has no such project yet).
 * The create's own settling restarts the reads that never got data
 * (`project-commands`).
 *
 * `AppQueryProvider` installs the gate as the default `enabled`. A hook that
 * sets its own `enabled` replaces the default and passes it through
 * `projectReadEnabled`. Not covered: `prefetchQuery`/`fetchQuery`/
 * `ensureQueryData` and suspense queries, which ignore `enabled`.
 */
import type { Query } from "@tanstack/react-query";

import { readPendingProjectCreation } from "@/client/query/project-commands";

export function isProjectReadPaused(queryKey: readonly unknown[]): boolean {
  // The project detail key is ["projects", "detail", id].
  const projectId =
    queryKey[0] === "projects" ? (queryKey[1] === "detail" ? queryKey[2] : queryKey[1]) : null;
  return typeof projectId === "string" && readPendingProjectCreation(projectId) !== undefined;
}

/** The `enabled` for a read whose caller can also switch it off. */
export function projectReadEnabled(callerEnabled = true) {
  // biome-ignore lint/suspicious/noExplicitAny: TanStack's `enabled` takes the query's own types, which are invariant. slop-lint: allow suppression the reason is stated in this comment
  return (query: Query<any, any, any, any>) =>
    callerEnabled && !isProjectReadPaused(query.queryKey);
}
