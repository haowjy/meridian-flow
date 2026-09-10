import type { WorksSnapshot } from "@meridian/contracts/works";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import { seedProjectRouteData } from "./project-route-data";

const snapshot = (revision: string, name: string): WorksSnapshot => ({
  projectId: "project-1" as never,
  catalogGeneration: "generation-1",
  authorityRevision: revision,
  requestId: `loader-${revision}`,
  works: [
    {
      id: "work-1",
      projectId: "project-1",
      createdByUserId: "user-1",
      name,
      slug: "work-1" as never,
      goal: null,
      description: null,
      status: "active",
      archivedAt: null,
      aiWriteMode: "direct",
      entityRevision: revision,
      unpushedChangeCount: 0,
      createdAt: "2026-08-29T00:00:00.000Z",
      updatedAt: "2026-08-29T00:00:00.000Z",
      lastActivityAt: "2026-08-29T00:00:00.000Z",
      deletedAt: null,
    },
  ],
});

describe("project route Works hydration", () => {
  it("cannot overwrite a newer live request or mutation snapshot", () => {
    const client = new QueryClient();
    const key = projectQueryKeys.works("project-1");
    client.setQueryData(key, snapshot("4", "restored live"));
    seedProjectRouteData(client, "project-1", {
      threads: null,
      works: snapshot("3", "deleted loader"),
      worksStarted: 1,
      workingSet: { status: "absent" },
    });
    expect(client.getQueryData<WorksSnapshot>(key)?.works[0]?.name).toBe("restored live");
  });

  it("hydrates an empty key and accepts only a strictly newer later loader", () => {
    const client = new QueryClient();
    const key = projectQueryKeys.works("project-1");
    seedProjectRouteData(client, "project-1", {
      threads: null,
      works: snapshot("1", "seed"),
      worksStarted: 1,
      workingSet: { status: "absent" },
    });
    seedProjectRouteData(client, "project-1", {
      threads: null,
      works: snapshot("2", "newer seed"),
      worksStarted: 2,
      workingSet: { status: "absent" },
    });
    expect(client.getQueryData<WorksSnapshot>(key)?.works[0]?.name).toBe("newer seed");
  });
});
