/**
 * A manifest wake hint is how another page's Apply or Discard reaches this page's draft lists.
 * A Work-scoped hint re-reads that Work's list only, and a hint that installs nothing new re-reads none.
 */
import type { CatalogWakeHint } from "@meridian/contracts/protocol";
import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { projectQueryKeys } from "./project-query-keys";
import { pullContextCatalogOnHint } from "./useContextCatalog";

const hint = {
  scope: { kind: "project", projectId: "project-a" },
  headRevision: "5",
} as unknown as CatalogWakeHint;

const workHint = (workId: string, headRevision = "5") =>
  ({
    scope: { kind: "work", projectId: "project-a", workId },
    headRevision,
  }) as unknown as CatalogWakeHint;

const installed = (appliedRevision: string) => ({ appliedRevision, entries: new Map() });
const invalidated = (queryClient: QueryClient, workId: string) =>
  queryClient.getQueryState(projectQueryKeys.workDrafts("project-a", workId))?.isInvalidated;

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

it("leaves the draft lists alone when the catalog could not be pulled", async () => {
  const queryClient = new QueryClient();
  const mine = projectQueryKeys.workDrafts("project-a", "work-1");
  queryClient.setQueryData(mine, []);
  const resources = { hintCatalog: vi.fn().mockRejectedValue(new Error("offline")) };

  pullContextCatalogOnHint(queryClient, resources, "project-a", hint);
  await Promise.resolve();
  await Promise.resolve();
  expect(queryClient.getQueryState(mine)?.isInvalidated).toBe(false);
});

it("re-reads only the hinted Work's draft list for a Work-scoped hint", async () => {
  const queryClient = new QueryClient();
  for (const work of ["work-0", "work-1", "work-2"]) {
    queryClient.setQueryData(projectQueryKeys.workDrafts("project-a", work), []);
  }
  const resources = { hintCatalog: vi.fn().mockResolvedValue(installed("5")) };

  pullContextCatalogOnHint(queryClient, resources, "project-a", workHint("work-1"));
  await vi.waitFor(() => expect(invalidated(queryClient, "work-1")).toBe(true));
  expect(invalidated(queryClient, "work-0")).toBe(false);
  expect(invalidated(queryClient, "work-2")).toBe(false);
});

it("does not re-read again for a hint whose catalog revision was already handled", async () => {
  const queryClient = new QueryClient();
  const key = projectQueryKeys.workDrafts("project-a", "work-1");
  queryClient.setQueryData(key, []);
  const hintCatalog = vi.fn().mockResolvedValue(installed("5"));

  pullContextCatalogOnHint(queryClient, { hintCatalog }, "project-a", workHint("work-1"));
  await vi.waitFor(() => expect(invalidated(queryClient, "work-1")).toBe(true));
  // The list was re-read and is fresh again; the same revision arrives twice more.
  queryClient.setQueryData(key, []);
  for (const headRevision of ["5", "4"]) {
    pullContextCatalogOnHint(
      queryClient,
      { hintCatalog },
      "project-a",
      workHint("work-1", headRevision),
    );
  }
  await vi.waitFor(() => expect(hintCatalog).toHaveBeenCalledTimes(3));
  await Promise.resolve();
  expect(invalidated(queryClient, "work-1")).toBe(false);

  // A newer revision is a real change.
  hintCatalog.mockResolvedValue(installed("6"));
  pullContextCatalogOnHint(queryClient, { hintCatalog }, "project-a", workHint("work-1", "6"));
  await vi.waitFor(() => expect(invalidated(queryClient, "work-1")).toBe(true));
});

it("tracks the handled revision per scope", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(projectQueryKeys.workDrafts("project-a", "work-1"), []);
  queryClient.setQueryData(projectQueryKeys.workDrafts("project-a", "work-2"), []);
  const resources = { hintCatalog: vi.fn().mockResolvedValue(installed("5")) };

  pullContextCatalogOnHint(queryClient, resources, "project-a", workHint("work-1"));
  await vi.waitFor(() => expect(invalidated(queryClient, "work-1")).toBe(true));
  pullContextCatalogOnHint(queryClient, resources, "project-a", workHint("work-2"));
  await vi.waitFor(() => expect(invalidated(queryClient, "work-2")).toBe(true));
});

it("still re-reads every Work's list of the project for a project-wide manifest hint, once per revision", async () => {
  const queryClient = new QueryClient();
  const keys = ["work-1", "work-2"].map((work) => projectQueryKeys.workDrafts("project-a", work));
  for (const key of keys) queryClient.setQueryData(key, []);
  const hintCatalog = vi.fn().mockResolvedValue(installed("7"));

  pullContextCatalogOnHint(queryClient, { hintCatalog }, "project-a", hint);
  await vi.waitFor(() => expect(invalidated(queryClient, "work-1")).toBe(true));
  expect(invalidated(queryClient, "work-2")).toBe(true);

  for (const key of keys) queryClient.setQueryData(key, []);
  pullContextCatalogOnHint(queryClient, { hintCatalog }, "project-a", hint);
  await vi.waitFor(() => expect(hintCatalog).toHaveBeenCalledTimes(2));
  await Promise.resolve();
  expect(invalidated(queryClient, "work-1")).toBe(false);
});

it("leaves project draft lists alone for a user-scoped hint", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(projectQueryKeys.workDrafts("project-a", "work-1"), []);
  const hintCatalog = vi.fn().mockResolvedValue(installed("3"));
  const userHint = {
    scope: { kind: "user", userId: "u" },
    headRevision: "3",
  } as unknown as CatalogWakeHint;

  pullContextCatalogOnHint(queryClient, { hintCatalog }, "project-a", userHint);
  await vi.waitFor(() => expect(hintCatalog).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  await Promise.resolve();
  expect(invalidated(queryClient, "work-1")).toBe(false);
});
