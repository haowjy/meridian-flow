import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { createThreadCache } from "./thread-cache";

describe("createThreadCache terminal invalidation", () => {
  it("invalidates the canonical Work catalog with the other agent-turn projections", async () => {
    const client = new QueryClient();
    const projectId = "project-1";
    const threadId = "thread-1";
    const keys = [
      threadQueryKeys.snapshot(threadId),
      projectQueryKeys.threads(projectId),
      projectQueryKeys.works(projectId),
      projectQueryKeys.workDrafts(projectId, "work-1"),
      projectQueryKeys.contextTree(projectId, "scratch", "work-1"),
    ] as const;

    for (const key of keys) client.setQueryData(key, { fresh: true });

    createThreadCache(client).invalidateThread(threadId, projectId);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
  });
});
