import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import {
  contextDeskReconciliation,
  mergeBootstrapDeskTabs,
  seedWorkingSetTabs,
  settleSeededRoutes,
  validateContextDeskTabs,
} from "./working-set-tab-seeding";

const mocks = vi.hoisted(() => ({ availability: vi.fn(), readTree: vi.fn() }));
vi.mock("@/client/query/useContextCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/query/useContextCatalog")>()),
  fetchContextCatalogView: mocks.readTree,
}));
vi.mock("@/client/query/project-context-availability", () => ({
  lookupProjectContextAvailability: mocks.availability,
}));

beforeEach(() => {
  mocks.readTree.mockReset();
  mocks.availability.mockReset();
  useContextTabsStore.setState({ byProject: {}, _deskHydrated: true });
});

function catalogWith(files: readonly CatalogFile[]): CatalogContextView {
  return {
    projectId: "project",
    scheme: "scratch",
    normalized: {} as CatalogContextView["normalized"],
    root: {
      kind: "dir",
      entryId: "scratch-source",
      parentId: null,
      name: "Scratch",
      path: "/",
      uri: "scratch://@work-a/",
    },
    children: () => files,
    files: () => files,
    findPath: (path) => files.find((file) => file.path === path) ?? null,
    findDocument: (documentId) => files.find((file) => file.documentId === documentId) ?? null,
  };
}

describe("Context desk bootstrap source", () => {
  it("replaces from authoritative server hydration and preserves degraded local state", () => {
    expect(
      contextDeskReconciliation({
        status: "server",
        row: {
          userId: "user-1",
          projectId: "project-1",
          revision: 1,
          recentRoutes: [],
          lastThreadId: null,
          updatedAt: new Date(0).toISOString(),
        },
      }),
    ).toBe("server-replace");
    expect(contextDeskReconciliation({ status: "read-degraded" })).toBe("local-keep");
  });
});

describe("server hydration route settlement", () => {
  const restored: ContextTab = {
    kind: "tracked",
    documentId: "a",
    scheme: "manuscript",
    path: "/a.md",
    name: "a.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };

  it("preserves the restored row on rejection", () => {
    expect(
      settleSeededRoutes(
        [{ documentId: "a", scheme: "manuscript", path: "/a.md" }],
        [restored],
        [{ status: "rejected", reason: new Error("offline") }],
      ),
    ).toEqual([{ tab: restored, removedRoute: null }]);
  });

  it("drops only a positively missing row and accepts refreshed metadata", () => {
    const refreshed = { ...restored, name: "renamed.md" };
    expect(
      settleSeededRoutes(
        [
          { documentId: "a", scheme: "manuscript", path: "/a.md" },
          { documentId: "missing", scheme: "kb", path: "/missing.md" },
        ],
        [restored],
        [
          { status: "fulfilled", value: { tab: refreshed, removedRoute: null } },
          {
            status: "fulfilled",
            value: {
              tab: null,
              removedRoute: { documentId: "missing", scheme: "kb", path: "/missing.md" },
            },
          },
        ],
      ),
    ).toEqual([
      { tab: refreshed, removedRoute: null },
      { tab: null, removedRoute: { documentId: "missing", scheme: "kb", path: "/missing.md" } },
    ]);
  });

  it("repairs an ordinary restored tab by exact availability without acquiring a catalog", async () => {
    useContextTabsStore.setState({
      byProject: { project: { tabs: [restored], selectedTabIdByWork: {} } },
    });
    mocks.availability.mockResolvedValue({
      projectId: "project",
      resolutionId: "lookup-1",
      resolutions: [
        {
          kind: "available",
          documentId: "a",
          generation: "1",
          authority: { kind: "project", projectId: "project" },
          entry: {
            kind: "file",
            entryId: "a",
            scope: { kind: "project", projectId: "project" },
            sourceId: "source",
            parentId: "source",
            name: "renamed.md",
            aliases: [],
            path: ["renamed.md"],
            uri: "manuscript://renamed.md",
            provisionalName: false,
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        },
      ],
    });

    await validateContextDeskTabs({
      queryClient: new QueryClient(),
      scope: { projectId: "project", editorWorkId: null, generation: 1 },
      isLiveScope: () => true,
    });

    expect(mocks.availability).toHaveBeenCalledWith("project", ["a"]);
    expect(mocks.readTree).not.toHaveBeenCalled();
    expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([
      expect.objectContaining({ documentId: "a", path: "/renamed.md", name: "renamed.md" }),
    ]);
  });

  it("preserves an ordinary restored tab when exact availability is unresolved", async () => {
    useContextTabsStore.setState({
      byProject: { project: { tabs: [restored], selectedTabIdByWork: {} } },
    });
    mocks.availability.mockRejectedValue(new Error("offline"));
    await validateContextDeskTabs({
      queryClient: new QueryClient(),
      scope: { projectId: "project", editorWorkId: null, generation: 1 },
      isLiveScope: () => true,
    });
    expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([
      expect.objectContaining(restored),
    ]);
    expect(mocks.readTree).not.toHaveBeenCalled();
  });
});

describe("device-local bootstrap ownership", () => {
  it("merges empty tabs without turning them into server recency", () => {
    const chapter: ContextTab = {
      kind: "tracked",
      documentId: "chapter",
      scheme: "manuscript",
      path: "/chapter.md",
      name: "chapter.md",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    };
    const local: ContextTab = {
      kind: "new",
      documentId: "local",
      name: "Untitled",
      workId: "work-a",
    };
    expect(mergeBootstrapDeskTabs([chapter], [local])).toEqual([chapter, local]);
  });

  it("preserves local origin while accepting refreshed server metadata by exact ID", () => {
    const refreshed: ContextTab = {
      kind: "tracked",
      documentId: "local",
      scheme: "scratch",
      path: "/Renamed.md",
      name: "Renamed.md",
      workId: "work-a",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      provisionalName: false,
    };
    const local: ContextTab = {
      ...refreshed,
      path: "/Untitled.md",
      name: "Untitled.md",
      origin: "local-untitled",
    };
    expect(mergeBootstrapDeskTabs([refreshed], [local])).toEqual([
      { ...refreshed, origin: "local-untitled" },
    ]);
  });

  it.each([
    ["server working-set bootstrap", "seed"],
    ["device-desk validation", "validate"],
  ] as const)("drops an absent local origin instead of transferring it by pathname during %s", async (_label, operation) => {
    const local: ContextTab = {
      kind: "tracked",
      documentId: "old-id",
      scheme: "scratch",
      path: "/Untitled.md",
      name: "Untitled.md",
      workId: "work-a",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      origin: "local-untitled",
    };
    useContextTabsStore.setState({
      byProject: {
        project: { tabs: [local], selectedTabIdByWork: { "work-a": local.documentId } },
      },
    });
    mocks.readTree.mockResolvedValue(
      catalogWith([
        {
          kind: "file",
          entryId: "replacement-id",
          parentId: "scratch-source",
          documentId: "replacement-id",
          name: "Untitled.md",
          path: "/Untitled.md",
          uri: "scratch://@work-a/Untitled.md",
          editable: true,
          filetype: "markdown",
          schemaType: "document",
          provisionalName: false,
        },
      ]),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const scope = { projectId: "project", editorWorkId: "work-a", generation: 1 };

    if (operation === "seed") {
      await seedWorkingSetTabs({ queryClient, routes: [], scope, isLiveScope: () => true });
    } else {
      await validateContextDeskTabs({ queryClient, scope, isLiveScope: () => true });
    }

    expect(useContextTabsStore.getState().byProject.project).toEqual({
      tabs: [],
      selectedTabIdByWork: {},
    });
  });

  it.each([
    ["server working-set bootstrap", "seed"],
    ["device-desk validation", "validate"],
  ] as const)("refreshes a same-ID local origin after a rename during %s", async (_label, operation) => {
    const local: ContextTab = {
      kind: "tracked",
      documentId: "same-id",
      scheme: "scratch",
      path: "/Untitled.md",
      name: "Untitled.md",
      workId: "work-a",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      origin: "local-untitled",
    };
    useContextTabsStore.setState({
      byProject: {
        project: { tabs: [local], selectedTabIdByWork: { "work-a": local.documentId } },
      },
    });
    mocks.readTree.mockResolvedValue(
      catalogWith([
        {
          kind: "file",
          entryId: "same-id",
          parentId: "scratch-source",
          documentId: "same-id",
          name: "Renamed.md",
          path: "/Renamed.md",
          uri: "scratch://@work-a/Renamed.md",
          editable: true,
          filetype: "markdown",
          schemaType: "document",
          provisionalName: false,
        },
      ]),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const scope = { projectId: "project", editorWorkId: "work-a", generation: 1 };

    if (operation === "seed") {
      await seedWorkingSetTabs({ queryClient, routes: [], scope, isLiveScope: () => true });
    } else {
      await validateContextDeskTabs({ queryClient, scope, isLiveScope: () => true });
    }

    expect(useContextTabsStore.getState().byProject.project).toEqual({
      tabs: [
        expect.objectContaining({
          documentId: "same-id",
          path: "/Renamed.md",
          name: "Renamed.md",
          origin: "local-untitled",
        }),
      ],
      selectedTabIdByWork: { "work-a": "same-id" },
    });
  });
});
