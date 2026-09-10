/** QueryClient coverage for project-lifetime catalog-to-Works observation. */
import type { CatalogEntry, CatalogScope } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { catalogViewFromSnapshot } from "./context-catalog-cache";
import { projectQueryKeys } from "./project-query-keys";

const api = vi.hoisted(() => ({ listProjectWorks: vi.fn() }));
vi.mock("@/client/api/projects-api", () => api);

const { observeWorksAvailability } = await import("./works-availability-observer");

const scope = { kind: "project", projectId: "project-1" } as const satisfies CatalogScope;
function authority(entityRevision: string): CatalogEntry {
  return {
    kind: "authority",
    entryId: "work-1" as never,
    scope,
    authority: { kind: "work", workId: "work-1" as never, workSlug: "draft" as never },
    name: "Draft",
    available: true,
    entityRevision,
  };
}
function view(entityRevision: string) {
  return catalogViewFromSnapshot({
    scope,
    generation: "catalog-1",
    headRevision: entityRevision,
    cursor: `cursor-${entityRevision}`,
    entries: [authority(entityRevision)],
  });
}

describe("Works availability observer", () => {
  it("refreshes the canonical Works key from an installed entity transition", async () => {
    api.listProjectWorks.mockResolvedValue({
      projectId: "project-1",
      catalogGeneration: "catalog-1",
      authorityRevision: "2",
      requestId: "request-2",
      works: [],
    });
    const client = new QueryClient();
    const catalogKey = projectQueryKeys.contextCatalog("project-1", scope);
    client.setQueryData(catalogKey, view("1"));
    const stop = observeWorksAvailability(client, "project-1");
    client.setQueryData(catalogKey, view("2"));
    await vi.waitFor(() => expect(api.listProjectWorks).toHaveBeenCalledWith("project-1"));
    expect(client.getQueryData(projectQueryKeys.works("project-1"))).toMatchObject({
      authorityRevision: "2",
    });
    stop();
    client.clear();
  });
});
