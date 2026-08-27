import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { createThreadCache } from "./thread-cache";

describe("createThreadCache terminal invalidation", () => {
  it("uses the canonical project policy once and leaves unrelated keys valid", async () => {
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
    const unrelated = [
      threadQueryKeys.snapshot("thread-2"),
      projectQueryKeys.workDrafts("project-2", "work-1"),
      projectQueryKeys.contextTree("project-2", "scratch", "work-1"),
    ] as const;

    for (const key of [...keys, ...unrelated]) client.setQueryData(key, { fresh: true });
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    createThreadCache(client).invalidateThread(threadId, projectId);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(true);
    }
    for (const key of unrelated) {
      expect(client.getQueryState(key)?.isInvalidated, JSON.stringify(key)).toBe(false);
    }
    expect(
      invalidateQueries.mock.calls.filter(
        ([filters]) =>
          JSON.stringify(filters?.queryKey) === JSON.stringify(threadQueryKeys.thread(threadId)),
      ),
    ).toHaveLength(1);
  });

  it("invalidates only the direct thread root when project identity is unavailable", async () => {
    const client = new QueryClient();
    const direct = [
      threadQueryKeys.snapshot("thread-1"),
      threadQueryKeys.uploads("thread-1"),
    ] as const;
    const unrelated = [
      threadQueryKeys.snapshot("thread-2"),
      projectQueryKeys.threads("project-1"),
      projectQueryKeys.works("project-1"),
    ] as const;
    for (const key of [...direct, ...unrelated]) client.setQueryData(key, { fresh: true });
    const invalidateQueries = vi.spyOn(client, "invalidateQueries");

    createThreadCache(client).invalidateThread("thread-1", null);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    for (const key of direct) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of unrelated) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    expect(invalidateQueries).toHaveBeenCalledTimes(1);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: threadQueryKeys.thread("thread-1"),
    });
  });
});
