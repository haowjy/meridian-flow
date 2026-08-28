import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import {
  contextDeskReconciliation,
  mergeBootstrapDeskTabs,
  seedWorkingSetTabs,
  settleSeededRoutes,
  validateContextDeskTabs,
} from "./working-set-tab-seeding";

const mocks = vi.hoisted(() => ({ readTree: vi.fn() }));
vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/projects-api")>()),
  getProjectContextTree: mocks.readTree,
}));

beforeEach(() => {
  mocks.readTree.mockReset();
  useContextTabsStore.setState({ byProject: {}, _deskHydrated: true });
});

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
        [{ scheme: "manuscript", path: "/a.md" }],
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
          { scheme: "manuscript", path: "/a.md" },
          { scheme: "kb", path: "/missing.md" },
        ],
        [restored],
        [
          { status: "fulfilled", value: { tab: refreshed, removedRoute: null } },
          {
            status: "fulfilled",
            value: {
              tab: null,
              removedRoute: { scheme: "kb", path: "/missing.md" },
            },
          },
        ],
      ),
    ).toEqual([
      { tab: refreshed, removedRoute: null },
      { tab: null, removedRoute: { scheme: "kb", path: "/missing.md" } },
    ]);
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
    mocks.readTree.mockResolvedValue({
      tree: {
        kind: "dir",
        name: "Scratch",
        path: "",
        children: [
          {
            kind: "file",
            documentId: "replacement-id",
            name: "Untitled.md",
            path: "/Untitled.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
      },
      capabilities: null,
    });
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
    mocks.readTree.mockResolvedValue({
      tree: {
        kind: "dir",
        name: "Scratch",
        path: "",
        children: [
          {
            kind: "file",
            documentId: "same-id",
            name: "Renamed.md",
            path: "/Renamed.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
      },
      capabilities: null,
    });
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
