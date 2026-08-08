import type { ListWorksResponse, ThreadListItem } from "@meridian/contracts/protocol";
import type { RebindThreadWorkResponse } from "@meridian/contracts/works";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import {
  convergeThreadWorkBinding,
  readStableThreadWorkBinding,
} from "./thread-work-binding-cache";

const { listProjectThreads, listProjectWorks } = vi.hoisted(() => ({
  listProjectThreads: vi.fn(),
  listProjectWorks: vi.fn(),
}));
vi.mock("@/client/api/projects-api", () => ({ listProjectThreads, listProjectWorks }));

const response = {
  threadId: "thread-1",
  previousWorkId: "work-a",
  work: { id: "work-b", name: "B" },
  changed: true,
  preferenceChanged: true,
  receipt: { inverse: { command: "switch", workId: "work-a" } },
} as RebindThreadWorkResponse;

describe("thread Work binding convergence", () => {
  it("ignores an older projection cursor", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.works("project-1"), {
      defaultWorkId: "work-a",
      works: [response.work],
    });
    convergeThreadWorkBinding(client, {
      source: "projected",
      seq: "12",
      signal: { projectId: "project-1", threadId: "thread-1", workId: "work-b" },
    });
    convergeThreadWorkBinding(client, {
      source: "projected",
      seq: "11",
      signal: { projectId: "project-1", threadId: "thread-1", workId: "work-a" },
    });
    expect(client.getQueryData(threadQueryKeys.workProjectionCursor("thread-1"))).toEqual({
      seq: "12",
      workId: "work-b",
    });
  });

  it("patches confirmed binding and preference synchronously", () => {
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.threads("project-1"), [
      { id: "thread-1", workId: "work-a" },
    ]);
    client.setQueryData(projectQueryKeys.works("project-1"), {
      defaultWorkId: "work-a",
      works: [response.work],
    });
    convergeThreadWorkBinding(client, {
      source: "confirmed",
      projectId: "project-1",
      result: response,
    });
    expect(
      client.getQueryData<ThreadListItem[]>(projectQueryKeys.threads("project-1"))?.[0].workId,
    ).toBe("work-b");
    expect(
      client.getQueryData<ListWorksResponse>(projectQueryKeys.works("project-1"))?.defaultWorkId,
    ).toBe("work-b");
  });

  it("retries a causal read when a projection arrives during the first read", async () => {
    const client = new QueryClient();
    listProjectThreads
      .mockImplementationOnce(async () => {
        client.setQueryData(threadQueryKeys.workProjectionCursor("thread-1"), {
          seq: "2",
          workId: "work-c",
        });
        return [{ id: "thread-1", projectId: "project-1", workId: "work-b" }];
      })
      .mockResolvedValue([{ id: "thread-1", projectId: "project-1", workId: "work-c" }]);
    listProjectWorks.mockResolvedValue({
      defaultWorkId: "work-c",
      works: [{ id: "work-c", name: "C" }],
    });
    await expect(
      readStableThreadWorkBinding(client, {
        projectId: "project-1",
        threadId: "thread-1",
        previousWorkId: "work-a",
      }),
    ).resolves.toMatchObject({ workId: "work-c" });
    expect(listProjectThreads).toHaveBeenCalledTimes(2);
  });
});
