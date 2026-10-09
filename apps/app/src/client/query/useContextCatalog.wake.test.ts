/** A manifest wake hint is how another page's Apply or Discard reaches this page's draft lists. */
import type { CatalogWakeHint } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import { pullContextCatalogOnHint } from "./useContextCatalog";

const hint = {
  scope: { kind: "project", projectId: "project-a" },
  headRevision: "5",
} as unknown as CatalogWakeHint;

it("re-reads the project's draft lists once the pulled catalog is installed, and no other project's", async () => {
  const queryClient = new QueryClient();
  const mine = projectQueryKeys.workDrafts("project-a", "work-1");
  const other = projectQueryKeys.workDrafts("project-b", "work-1");
  queryClient.setQueryData(mine, []);
  queryClient.setQueryData(other, []);
  const resources = { hintCatalog: vi.fn().mockResolvedValue({ entries: new Map() }) };

  pullContextCatalogOnHint(queryClient, resources, "project-a", hint);
  await vi.waitFor(() => expect(queryClient.getQueryState(mine)?.isInvalidated).toBe(true));
  expect(queryClient.getQueryState(other)?.isInvalidated).toBe(false);
});
