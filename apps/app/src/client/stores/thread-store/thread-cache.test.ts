/**
 * thread-cache tests — locks the React Query invalidation seam used by
 * terminal turn state transitions.
 */
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";

import { createThreadCache } from "./thread-cache";

describe("thread cache invalidation", () => {
  it("invalidates snapshot, drafts, and owning project threads after a terminal turn", async () => {
    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    createThreadCache(queryClient).invalidateThread("thread-1", "project-1");
    await Promise.resolve();

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.snapshot("thread-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.drafts("thread-1"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.threads("project-1"),
    });
  });
});
