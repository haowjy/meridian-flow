// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { MeridianApiError } from "@/client/api/http-client";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useContextTabsStore } from "@/client/stores";
import { AccountFeatureTestProvider } from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ProjectSearch } from "../routing/project-route";

const { deleted } = vi.hoisted(() => ({
  deleted: vi.fn(async () => ({
    status: "deleted" as const,
    deletedDocumentIds: ["document-a"],
    availabilityGeneration: "28",
  })),
}));

vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/projects-api")>()),
  deleteContextEntry: deleted,
}));

const { useDeleteConfirmation } = await import("./ContextEntryActions");
const { useContextRemovalCoordinator } = await import("./account-feature-context");

type Confirmation = ReturnType<typeof useDeleteConfirmation>;
let confirmation: Confirmation | null = null;
let changeWork: ((workId: string) => void) | null = null;
let contextRemoval: ReturnType<typeof useContextRemovalCoordinator> | null = null;

beforeEach(() => {
  confirmation = null;
  changeWork = null;
  deleted.mockClear();
  contextRemoval = null;
});

function Harness() {
  const [workId, setWorkId] = useState("work-a");
  changeWork = setWorkId;
  confirmation = useDeleteConfirmation({ projectId: "project", workId, scheme: "scratch" });
  return null;
}

function PopulatedHarness() {
  contextRemoval = useContextRemovalCoordinator();
  confirmation = useDeleteConfirmation({
    projectId: "project",
    workId: "work-1",
    scheme: "manuscript",
  });
  return null;
}

it("settles a populated-folder receipt through one terminal availability batch", async () => {
  deleted.mockResolvedValueOnce({
    status: "deleted",
    deletedDocumentIds: ["child-document", "child-document"],
    availabilityGeneration: "28",
  });
  useContextTabsStore.setState({
    byProject: {
      project: {
        tabs: [
          {
            kind: "tracked",
            documentId: "child-document",
            scheme: "manuscript",
            path: "/populated/child.md",
            name: "child.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
        selectedTabIdByWork: { "work-1": "child-document" },
      },
    },
    _deskHydrated: true,
  });
  let search: ProjectSearch = {
    screen: "context" as const,
    work: "work-1",
    scheme: "manuscript" as const,
    path: "/populated/child.md",
    folder: "/populated",
  };
  const routeUpdates: ProjectSearch[] = [];
  const route = {
    readSearch: () => search,
    updateSearch: (_projectId: string, update: (current: ProjectSearch) => ProjectSearch) => {
      search = update(search);
      routeUpdates.push(search);
    },
  };
  const queryClient = new QueryClient();

  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <AccountFeatureTestProvider accountId="account-1">
        <PopulatedHarness />
      </AccountFeatureTestProvider>
    </QueryClientProvider>,
    async () => {
      if (!contextRemoval) throw new Error("removal coordinator did not mount");
      contextRemoval.registerRoutePort("project", route, "work-1");
      const revision = contextRemoval.beginRouteSelection("project", {
        scheme: "manuscript",
        path: "/populated/child.md",
        workId: "work-1",
      });
      contextRemoval.bindRouteSelection("project", revision, {
        kind: "server",
        documentId: "child-document",
      });
      act(() =>
        confirmation?.requestDelete({ name: "populated", path: "/populated", kind: "dir" }),
      );
      await act(async () => confirmation?.confirm());
      expect(contextRemoval?.getProjectSnapshot("project")).toMatchObject({
        selection: { status: "none" },
        removalFence: { removedDocumentIds: ["child-document"] },
      });
    },
  );

  expect(deleted).toHaveBeenCalledWith(
    "project",
    "manuscript",
    { path: "/populated", expected: { kind: "folder" } },
    undefined,
  );
  expect(routeUpdates).toEqual([{ screen: "context", work: "work-1" }]);
  expect(search).toEqual({ screen: "context", work: "work-1" });
  expect(useContextTabsStore.getState().byProject.project).toEqual({
    tabs: [],
    selectedTabIdByWork: {},
  });
});

it("submits the Work captured when delete confirmation was requested", async () => {
  const queryClient = new QueryClient();
  useContextTabsStore.setState({
    byProject: {
      project: {
        tabs: [
          {
            kind: "tracked",
            documentId: "document-a",
            scheme: "scratch",
            path: "/same.md",
            name: "same.md",
            workId: "work-a",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
          {
            kind: "tracked",
            documentId: "document-b",
            scheme: "scratch",
            path: "/other.md",
            name: "other.md",
            workId: "work-a",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
        selectedTabIdByWork: { "work-1": "document-b" },
      },
    },
    _deskHydrated: true,
  });
  const invalidation = vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async () => {
    expect(
      useContextTabsStore
        .getState()
        .byProject.project?.tabs.some((tab) => tab.documentId === "document-a"),
    ).toBe(false);
  });
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <AccountFeatureTestProvider accountId="account-1">
        <Harness />
      </AccountFeatureTestProvider>
    </QueryClientProvider>,
    async () => {
      act(() =>
        confirmation?.requestDelete({
          name: "same.md",
          path: "/same.md",
          kind: "file",
          documentId: "document-a",
        }),
      );
      await act(async () => changeWork?.("work-b"));
      await act(async () => confirmation?.confirm());
    },
  );

  expect(deleted).toHaveBeenCalledWith(
    "project",
    "scratch",
    {
      path: "/same.md",
      expected: { kind: "file", documentId: "document-a" },
    },
    { workId: "work-a" },
  );
  expect(invalidation).toHaveBeenCalledOnce();
  expect(invalidation).toHaveBeenCalledWith({
    queryKey: projectQueryKeys.contextCatalogView("project", "scratch", "work-a"),
  });
  expect(useContextTabsStore.getState().byProject.project?.tabs).toMatchObject([
    { documentId: "document-b" },
  ]);
});

it("keeps a stale-target confirmation open with a retry error", async () => {
  const staleTarget = new MeridianApiError({
    code: "stale_target",
    message: "The context entry changed. Refresh and try again.",
    retryable: true,
    source: "system",
  });
  deleted.mockRejectedValueOnce(staleTarget);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await withReactRoot(
    <QueryClientProvider client={queryClient}>
      <AccountFeatureTestProvider accountId="account-1">
        <Harness />
      </AccountFeatureTestProvider>
    </QueryClientProvider>,
    async () => {
      act(() =>
        confirmation?.requestDelete({
          name: "changed.md",
          path: "/changed.md",
          kind: "file",
          documentId: "old-document",
        }),
      );
      await act(async () => confirmation?.confirm());
      expect(confirmation?.target).toMatchObject({ documentId: "old-document" });
      await vi.waitFor(() => expect(confirmation?.error).toBe(staleTarget));
    },
  );
});
