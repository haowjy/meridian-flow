/** Canonical cache convergence for committed Work entity and thread-binding facts. */
import type { WorkReceipt } from "@meridian/contracts/works";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateProjectHomeFeed, invalidateWorkThreads } from "./project-invalidation";
import { projectQueryKeys } from "./project-query-keys";

export type WorkProjectionChange =
  | { kind: "binding"; projectId: string }
  | {
      kind: "entity";
      projectId: string;
      operation:
        | Extract<WorkReceipt, { category: "mutate" }>["operation"]
        | "archive"
        | "unarchive"
        | "restore";
    };

export function convergeWorkProjection(client: QueryClient, change: WorkProjectionChange): void {
  void client.invalidateQueries({ queryKey: projectQueryKeys.threads(change.projectId) });
  void invalidateProjectHomeFeed(client, change.projectId);
  if (change.kind === "binding" || change.operation !== "create") {
    void invalidateWorkThreads(client, change.projectId);
  }
}
