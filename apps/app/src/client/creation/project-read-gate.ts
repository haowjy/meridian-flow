/**
 * Pauses every TanStack query under `["projects", id, ...]` while that
 * project's create is pending or failed (the server has no such project yet),
 * and restarts the paused reads when the create is confirmed.
 *
 * `AppQueryProvider` installs the gate as the default `enabled`. A hook that
 * sets its own `enabled` replaces the default and passes it through
 * `projectReadEnabled`. Not covered: `prefetchQuery`/`fetchQuery`/
 * `ensureQueryData` and suspense queries, which ignore `enabled`.
 */
import type { Query, QueryClient } from "@tanstack/react-query";

import { creationRecordKey, creationRegistry, readCreationRecord } from "./creation-registry";

function isUnresolved(status: string | undefined): boolean {
  return status === "pending" || status === "failed";
}

export function isProjectReadPaused(queryKey: readonly unknown[]): boolean {
  // The project detail key is ["projects", "detail", id].
  const projectId =
    queryKey[0] === "projects" ? (queryKey[1] === "detail" ? queryKey[2] : queryKey[1]) : null;
  if (typeof projectId !== "string") return false;
  return isUnresolved(readCreationRecord(creationRecordKey("project", projectId))?.status);
}

/** The `enabled` for a read whose caller can also switch it off. */
export function projectReadEnabled(callerEnabled = true) {
  // biome-ignore lint/suspicious/noExplicitAny: TanStack's `enabled` takes the query's own types, which are invariant. slop-lint: allow suppression the reason is stated in this comment
  return (query: Query<any, any, any, any>) =>
    callerEnabled && !isProjectReadPaused(query.queryKey);
}

/**
 * A function-valued `enabled` that turns true again does not make TanStack
 * fetch, so a paused read would wait for focus. When a project's create is
 * confirmed, fetch its active reads that never got data.
 */
export function installProjectReadRestart(client: QueryClient): () => void {
  return creationRegistry.subscribe((state, previous) => {
    for (const [key, record] of Object.entries(state.records)) {
      if (record.status !== "confirmed" || !key.startsWith("project:")) continue;
      if (!isUnresolved(previous.records[key]?.status)) continue;
      void client.refetchQueries({
        queryKey: ["projects", key.slice("project:".length)],
        type: "active",
        predicate: (query) => query.state.data === undefined,
      });
    }
  });
}
