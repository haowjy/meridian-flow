/** Canonical cache convergence for committed Work entity and thread-binding facts. */
import type { Query, QueryClient } from "@tanstack/react-query";
import { invalidateProjectChatFeed, invalidateWorkThreads } from "./project-invalidation";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import type { WorkOperation } from "./work-commands";

export type WorkProjectionChange =
  | { kind: "binding"; projectId: string }
  | { kind: "entity"; projectId: string; operation: WorkOperation };

export function convergeWorkProjection(client: QueryClient, change: WorkProjectionChange): void {
  void client.invalidateQueries({ queryKey: projectQueryKeys.threads(change.projectId) });
  void invalidateProjectChatFeed(client, change.projectId);
  if (change.kind === "binding" || change.operation !== "create") {
    void invalidateWorkThreads(client, change.projectId);
  }
  if (change.kind !== "entity") return;
  // Deleting a Work deletes its chats, and restoring it brings them back. A chat learns
  // either only from its snapshot: an open one leaves on the refetched "deleted", and a
  // restored one must not reopen onto the "deleted" answer still cached for it.
  if (change.operation === "delete")
    void client.invalidateQueries({ queryKey: threadQueryKeys.all, predicate: isThreadSnapshot });
  if (change.operation === "restore")
    void client.resetQueries({
      queryKey: threadQueryKeys.all,
      predicate: (query) => isThreadSnapshot(query) && query.state.status === "error",
    });
}

function isThreadSnapshot(query: Query): boolean {
  return query.queryKey[2] === "snapshot";
}
