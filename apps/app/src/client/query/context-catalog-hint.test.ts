import { catalogViewFromSnapshot } from "@meridian/resource-replica";
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import { pullContextCatalogOnHint } from "./useContextCatalog";

const scope = { kind: "project" as const, projectId: "project-1" };

it("lets the durable acquisition owner evaluate a cold Work hint", async () => {
  const queryClient = new QueryClient();
  const workScope = {
    kind: "work" as const,
    projectId: "project-1",
    workId: "work-cold",
  };
  const next = catalogViewFromSnapshot({
    scope: workScope,
    generation: "generation",
    headRevision: "1",
    cursor: "cursor",
    entries: [],
  });
  const resources = { hintCatalog: vi.fn(async () => next) };
  pullContextCatalogOnHint(queryClient, resources, "project-1", {
    type: "context-catalog-hint",
    scope: workScope,
    headRevision: "1",
  });
  await vi.waitFor(() =>
    expect(resources.hintCatalog).toHaveBeenCalledWith("project-1", workScope, "1"),
  );
});

it("installs the account resource owner's hinted projection in the query cache", async () => {
  const queryClient = new QueryClient();
  const initial = catalogViewFromSnapshot({
    scope,
    generation: "generation-1",
    headRevision: "0",
    cursor: "cursor-0",
    entries: [],
  });
  const next = { ...initial, appliedRevision: "1", observedHeadRevision: "1" };
  const key = projectQueryKeys.contextCatalog("project-1", scope);
  queryClient.setQueryData(key, initial);
  const resources = { hintCatalog: vi.fn(async () => next) };
  pullContextCatalogOnHint(queryClient, resources, "project-1", {
    type: "context-catalog-hint",
    scope,
    headRevision: "1",
  });
  await vi.waitFor(() => expect(queryClient.getQueryData(key)).toEqual(next));
  expect(resources.hintCatalog).toHaveBeenCalledWith("project-1", scope, "1");
});
