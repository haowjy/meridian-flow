import type { ListWorksResponse, ThreadListItem } from "@meridian/contracts/protocol";
import type { RebindThreadWorkResponse } from "@meridian/contracts/works";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import { convergeThreadWork } from "./useRebindThreadWork";

describe("convergeThreadWork", () => {
  it("patches binding and primary preference before invalidation refetches", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      {
        id: "thread-1",
        projectId: "project-1",
        workId: "work-a",
        work: { id: "work-a", title: "A" },
      },
    ]);
    client.setQueryData(projectQueryKeys.works("project-1"), {
      defaultWorkId: "work-a",
      works: [{ id: "work-b", name: "B" }],
    });

    convergeThreadWork(client, "project-1", {
      threadId: "thread-1",
      previousWorkId: "work-a",
      work: { id: "work-b", name: "B" },
      changed: true,
      preferenceChanged: true,
      receipt: {},
      contextUpdate: "delivered",
    } as RebindThreadWorkResponse);

    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads("project-1"))?.[0],
    ).toMatchObject({
      workId: "work-b",
      work: { id: "work-b", title: "B" },
    });
    expect(
      client.getQueryData<ListWorksResponse>(projectQueryKeys.works("project-1"))?.defaultWorkId,
    ).toBe("work-b");
  });
});
