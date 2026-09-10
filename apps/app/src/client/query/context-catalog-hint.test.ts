import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getContextCatalogChanges } from "@/client/api/projects-api";
import { hintContextCatalog } from "./context-catalog-acquisition";
import { catalogViewFromSnapshot } from "./context-catalog-cache";
import { projectQueryKeys } from "./project-query-keys";
import { pullContextCatalogOnHint } from "./useContextCatalog";

vi.mock("@/client/api/projects-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/client/api/projects-api")>();
  return { ...original, getContextCatalogChanges: vi.fn() };
});

const scope = { kind: "project" as const, projectId: "project-1" };
const queryKey = projectQueryKeys.contextCatalog("project-1", scope);
const delta = (revision: number) => ({
  kind: "delta" as const,
  scope,
  commits: [
    {
      eventId: `event-${revision}`,
      commitId: `commit-${revision}`,
      firstRevision: String(revision),
      lastRevision: String(revision),
      changes: [],
    },
  ],
  nextCursor: `cursor-${revision}`,
  headRevision: String(revision),
  hasMore: false,
});

afterEach(() => vi.clearAllMocks());

describe("catalog acquisition coordinator", () => {
  it("does not materialize a cold Work query from a truth-free hint", () => {
    const queryClient = new QueryClient();
    const workScope = {
      kind: "work" as const,
      projectId: "project-1",
      workId: "work-cold",
    };
    pullContextCatalogOnHint(queryClient, "project-1", {
      type: "context-catalog-hint",
      scope: workScope,
      headRevision: "1",
    });
    expect(
      queryClient.getQueryState(projectQueryKeys.contextCatalog("project-1", workScope)),
    ).toBeUndefined();
    expect(getContextCatalogChanges).not.toHaveBeenCalled();
  });

  it("coalesces duplicate and successive hints into one drain from each cursor", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      queryKey,
      catalogViewFromSnapshot({
        scope,
        generation: "generation-1",
        headRevision: "0",
        cursor: "cursor-0",
        entries: [],
      }),
    );
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maximumActive = 0;
    vi.mocked(getContextCatalogChanges).mockImplementation(async (_projectId, _scope, cursor) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (cursor === "cursor-0") await blocked;
      active -= 1;
      return cursor === "cursor-0" ? delta(1) : delta(2);
    });

    const first = hintContextCatalog(queryClient, queryKey, "project-1", scope, "1");
    const duplicate = hintContextCatalog(queryClient, queryKey, "project-1", scope, "1");
    const newer = hintContextCatalog(queryClient, queryKey, "project-1", scope, "2");
    release();
    await Promise.all([first, duplicate, newer]);

    expect(maximumActive).toBe(1);
    expect(vi.mocked(getContextCatalogChanges).mock.calls.map((call) => call[2])).toEqual([
      "cursor-0",
      "cursor-1",
    ]);
    expect(queryClient.getQueryData<{ appliedRevision: string }>(queryKey)?.appliedRevision).toBe(
      "2",
    );
  });
});
