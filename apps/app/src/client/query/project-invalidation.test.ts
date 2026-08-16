import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { invalidateProjectThreadData, invalidateWorkThreads } from "./project-invalidation";
import { projectQueryKeys } from "./project-query-keys";

describe("project projection invalidation", () => {
  it("converges the thread, Work, and Home projections for one project", async () => {
    const client = new QueryClient();
    const owned = [
      projectQueryKeys.threads("project-1"),
      projectQueryKeys.works("project-1"),
      projectQueryKeys.homeFeed("project-1"),
    ] as const;
    const unrelated = [
      projectQueryKeys.homeFeed("project-2"),
      projectQueryKeys.detail("project-1"),
    ] as const;
    for (const key of [...owned, ...unrelated]) client.setQueryData(key, { fresh: true });

    await invalidateProjectThreadData(client, "project-1");

    for (const key of owned) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    for (const key of unrelated) expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  });
  it("invalidates one associated-chat leaf or the project prefix", async () => {
    const client = new QueryClient();
    const workA = projectQueryKeys.workThreads("project-1", "work-a");
    const workB = projectQueryKeys.workThreads("project-1", "work-b");
    const other = projectQueryKeys.workThreads("project-2", "work-a");
    for (const key of [workA, workB, other]) client.setQueryData(key, { fresh: true });

    await invalidateWorkThreads(client, "project-1", "work-a");
    expect(client.getQueryState(workA)?.isInvalidated).toBe(true);
    expect(client.getQueryState(workB)?.isInvalidated).toBe(false);

    await invalidateWorkThreads(client, "project-1");
    expect(client.getQueryState(workB)?.isInvalidated).toBe(true);
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
  });
});
