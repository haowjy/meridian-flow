/** Canonical cache convergence for committed Work entity and thread-binding facts. */
import type { QueryClient } from "@tanstack/react-query";
import { invalidateProjectChatFeed, invalidateWorkThreads } from "./project-invalidation";
import { projectQueryKeys } from "./project-query-keys";
import type { WorkOperation } from "./work-commands";

export type WorkProjectionChange =
  | { kind: "binding"; projectId: string }
  | { kind: "entity"; projectId: string; operation: WorkOperation | "create" };

export function convergeWorkProjection(client: QueryClient, change: WorkProjectionChange): void {
  void client.invalidateQueries({ queryKey: projectQueryKeys.threads(change.projectId) });
  void invalidateProjectChatFeed(client, change.projectId);
  if (change.kind === "binding" || change.operation !== "create") {
    void invalidateWorkThreads(client, change.projectId);
  }
}
