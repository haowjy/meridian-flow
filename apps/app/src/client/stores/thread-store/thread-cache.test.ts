/**
 * thread-cache tests — locks the React Query invalidation seam used by
 * terminal turn state transitions.
 */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";

import { createThreadCache } from "./thread-cache";

describe("thread cache invalidation", () => {
  it("invalidates snapshot, drafts, and owning project threads after a terminal turn", async () => {
    const queryClient = new QueryClient();
    const snapshotKey = threadQueryKeys.snapshot("thread-1");
    const draftsKey = threadQueryKeys.drafts("thread-1");
    const projectThreadsKey = projectQueryKeys.threads("project-1");
    queryClient.setQueryData(snapshotKey, { threadId: "thread-1" });
    queryClient.setQueryData(draftsKey, []);
    queryClient.setQueryData(projectThreadsKey, []);

    createThreadCache(queryClient).invalidateThread("thread-1", "project-1");
    await Promise.resolve();

    expect(queryClient.getQueryState(snapshotKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(draftsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(projectThreadsKey)?.isInvalidated).toBe(true);
  });
});
