// @vitest-environment jsdom
/** Production desktop route materialization under a pending removal repair. */

import { acceptContextTransition } from "@/test-support/context-removal-route";
import "fake-indexeddb/auto";

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { act, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { type ContextTab, rehydrateEditorWorkspace, useContextTabsStore } from "@/client/stores";
import {
  AccountFeatureTestProvider,
  useAccountResourceReplica,
  useContextRemovalCoordinator,
} from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextViewerSurfaceController } from "../ContextPaneController";
import type { ProjectSearch } from "../routing/project-route";
import type {
  ContextRemovalCoordinator,
  ContextRemovalRoutePort,
} from "./context-removal-coordinator";
import { ProjectContextRemovalController } from "./ProjectContextRemovalController";

const tree = {
  kind: "directory",
  name: "",
  path: "",
  children: [
    {
      kind: "file",
      name: "a.md",
      path: "/a.md",
      documentId: "a",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
  ],
};

const queryState = {
  tree,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
};

vi.mock("@/client/query/useContextCatalog", () => ({
  useContextCatalogView: () => queryState,
}));
type ViewerCapture = {
  tabs: ContextTab[];
  onNewDocument: () => void;
  onUntitledBecameNonEmpty: (documentId: string) => void;
};
let viewerProps: ViewerCapture | null = null;
vi.mock("./ContextViewer", () => ({
  ContextViewer: (props: ViewerCapture) => {
    viewerProps = props;
    return null;
  },
}));
let coordinator: ContextRemovalCoordinator | null = null;
let resources: ReturnType<typeof useAccountResourceReplica> | null = null;

function CaptureCoordinator() {
  coordinator = useContextRemovalCoordinator();
  resources = useAccountResourceReplica();
  return null;
}

beforeEach(() => {
  coordinator = null;
  resources = null;
  viewerProps = null;
  queryState.tree = tree;
  queryState.isError = false;
  queryState.isFetching = false;
  useContextTabsStore.setState({
    byProject: {
      project: {
        tabs: [
          {
            kind: "tracked",
            documentId: "a",
            scheme: "manuscript",
            path: "/a.md",
            name: "a.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
        selectedTabIdByWork: { "work-1": "a" },
      },
    },
    _workspaceHydrated: false,
  });
});

it("persists and admits the real New action without an empty working-set route", async () => {
  vi.stubGlobal("isSecureContext", true);
  const reportedErrors: unknown[] = [];
  vi.stubGlobal("reportError", (error: unknown) => reportedErrors.push(error));
  const originalLocks = navigator.locks;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock) => Promise<unknown>,
      ) => callback({ name: "test", mode: "exclusive" } as Lock),
    },
  });
  localStorage.clear();
  const writes: Array<{ key: string; value: string }> = [];
  const originalSetItem = Storage.prototype.setItem;
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    writes.push({ key, value });
    return originalSetItem.call(this, key, value);
  });
  useContextTabsStore.setState({ byProject: {}, _workspaceHydrated: false });
  await rehydrateEditorWorkspace(`new-action-${crypto.randomUUID()}`);
  let search: ProjectSearch = { screen: "context", work: "work-a" };
  let releaseLocalRoute: (() => void) | null = null;

  function Harness() {
    const [route, setRoute] = useState<{
      scheme: ProjectContextTreeScheme | null;
      path: string | null;
    }>({
      scheme: null,
      path: null,
    });
    const updateRoute = (path: string, scheme: ProjectContextTreeScheme = "unfiled") => {
      const commit = () => {
        search = { ...search, scheme, path };
        setRoute({ scheme, path });
      };
      if (scheme === "unfiled" && path === "") releaseLocalRoute = commit;
      else commit();
    };
    return (
      <AccountFeatureTestProvider accountId="new-action-account">
        <CaptureCoordinator />
        <ProjectContextRemovalController
          projectId="project"
          activeScreen="context"
          activeContextScheme={route.scheme}
          activeContextPath={route.path}
          editorWorkId="work-a"
          route={{
            transition: acceptContextTransition,
            readSearch: () => search,
            updateSearch: (_projectId, update) => {
              search = update(search);
              setRoute({
                scheme: search.scheme === "unfiled" ? "unfiled" : null,
                path: search.path ?? null,
              });
            },
          }}
        />
        <ContextViewerSurfaceController
          projectId="project"
          editorWorkId="work-a"
          activeContextScheme={route.scheme}
          activeContextPath={route.path}
          active
          sidebarToggle={{ open: true, onExpand: vi.fn(), label: "Sidebar" }}
          dockToggle={{ open: true, onExpand: vi.fn(), label: "Dock" }}
          onSelectContextPath={updateRoute}
          onShowEditorRecents={vi.fn()}
          onOpenContextTarget={(target, options) =>
            new Promise((resolve) => {
              releaseLocalRoute = () => {
                if (options?.tab) {
                  useContextTabsStore.getState().openTab("project", options.tab);
                  void useContextTabsStore
                    .getState()
                    .selectTab("project", "work-a", options.tab.documentId);
                }
                search = { ...search, scheme: target.scheme, path: target.path };
                setRoute({ scheme: target.scheme, path: target.path });
                resolve({ kind: "applied" });
              };
            })
          }
        />
      </AccountFeatureTestProvider>
    );
  }

  try {
    await withReactRoot(<Harness />, async () => {
      let opening: Promise<void> | undefined;
      await act(async () => {
        opening = Promise.resolve(viewerProps?.onNewDocument());
      });
      await act(async () => {
        await vi.waitFor(() => expect(releaseLocalRoute).toBeTypeOf("function"));
      });
      expect(useContextTabsStore.getState().byProject.project?.tabs ?? []).toEqual([]);
      await act(async () => {
        releaseLocalRoute?.();
        await opening;
      });
      const slice = useContextTabsStore.getState().byProject.project;
      const local = slice?.tabs.find((tab) => tab.kind === "new");
      expect(local).toBeDefined();
      expect(slice?.selectedTabIdByWork["work-a"]).toBe(local?.documentId);
      expect(search).toMatchObject({ scheme: "unfiled", path: "" });
      expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
        selection: { status: "bound", identity: { kind: "local", documentId: local?.documentId } },
        admitted: { scheme: "unfiled", path: "", workId: "work-a" },
      });
      const workspaceWrites = writes
        .filter((write) => write.key === "meridian:editor-workspace:v1")
        .map((write) => JSON.parse(write.value));
      expect(workspaceWrites.length).toBeGreaterThan(0);
      expect(workspaceWrites.every((workspace) => workspace.version === 1)).toBe(true);
      expect(workspaceWrites.at(-1)?.projects.project).toMatchObject({
        selectedTabIdByWork: { "work-a": local?.documentId },
      });
      expect(workspaceWrites.at(-1)?.projects.project.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "new",
            documentId: local?.documentId,
          }),
        ]),
      );
      expect(
        writes
          .filter((write) => write.key === "meridian:working-set")
          .some((write) => write.value.includes('"path":""')),
      ).toBe(false);
    });
  } finally {
    await resources?.finishClose();
    localStorage.clear();
    await rehydrateEditorWorkspace(`cleanup-${crypto.randomUUID()}`);
    setItem.mockRestore();
    Object.defineProperty(navigator, "locks", { configurable: true, value: originalLocks });
    vi.unstubAllGlobals();
    expect(reportedErrors).toEqual([]);
  }
});

it("guarded-redirects a selected materialized local owner before admitting its server route", async () => {
  const materialized: ContextTab = {
    kind: "tracked",
    documentId: "local-a",
    scheme: "unfiled",
    path: "/Untitled.md",
    name: "Untitled.md",
    workId: "work-a",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    origin: "local-resource",
  };
  useContextTabsStore.setState({
    byProject: {
      project: { tabs: [materialized], selectedTabIdByWork: { "work-a": materialized.documentId } },
    },
    _workspaceHydrated: true,
  });
  let search: ProjectSearch = {
    screen: "context",
    work: "work-a",
    scheme: "unfiled",
    path: "",
  };

  function Harness() {
    const [path, setPath] = useState("");
    return (
      <AccountFeatureTestProvider accountId="materialized-redirect-account">
        <CaptureCoordinator />
        <ProjectContextRemovalController
          projectId="project"
          activeScreen="context"
          activeContextScheme="unfiled"
          activeContextPath={path}
          editorWorkId="work-a"
          route={{
            transition: acceptContextTransition,
            readSearch: () => search,
            updateSearch: (_projectId, update) => {
              search = update(search);
              setPath(search.path ?? "");
            },
          }}
        />
        <ContextViewerSurfaceController
          projectId="project"
          editorWorkId="work-a"
          activeContextScheme="unfiled"
          activeContextPath={path}
          active
          sidebarToggle={{ open: true, onExpand: vi.fn(), label: "Sidebar" }}
          dockToggle={{ open: true, onExpand: vi.fn(), label: "Dock" }}
          onSelectContextPath={vi.fn()}
          onOpenContextTarget={vi.fn()}
          onShowEditorRecents={vi.fn()}
        />
      </AccountFeatureTestProvider>
    );
  }

  await withReactRoot(<Harness />, async () => {
    expect(search.path).toBe("/Untitled.md");
    expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
      selection: { status: "bound", identity: { documentId: materialized.documentId } },
      admitted: { scheme: "unfiled", path: "/Untitled.md", workId: "work-a" },
    });
  });
});

it("restores the exact older local owner across A to B to A through mounted controllers", async () => {
  const older: ContextTab = {
    kind: "new",
    documentId: "untitled-older",
    name: "Untitled",
    resourceHandle: "resource-untitled-older",
  };
  const newer: ContextTab = {
    ...older,
    documentId: "untitled-newer",
    resourceHandle: "resource-untitled-newer",
  };
  const chapter = useContextTabsStore.getState().byProject.project?.tabs[0] as ContextTab;
  useContextTabsStore.setState({
    byProject: {
      project: {
        tabs: [chapter, older, newer],
        selectedTabIdByWork: { "work-a": older.documentId, "work-b": chapter.documentId },
      },
    },
    _workspaceHydrated: false,
  });
  let selectWork: ((workId: string) => void) | null = null;
  let search: ProjectSearch = {
    screen: "context",
    work: "work-a",
    scheme: "unfiled",
    path: "",
  };

  function Harness() {
    const [workId, setWorkId] = useState("work-a");
    selectWork = (next) => {
      search =
        next === "work-a"
          ? { screen: "context", work: next, scheme: "unfiled", path: "" }
          : { screen: "context", work: next, scheme: "manuscript", path: "/a.md" };
      setWorkId(next);
    };
    return (
      <AccountFeatureTestProvider accountId="untitled-owner-account">
        <CaptureCoordinator />
        <ProjectContextRemovalController
          projectId="project"
          activeScreen="context"
          activeContextScheme={search.scheme ?? null}
          activeContextPath={search.path ?? null}
          editorWorkId={workId}
          route={{
            transition: acceptContextTransition,
            readSearch: () => search,
            updateSearch: (_projectId, update) => {
              search = update(search);
            },
          }}
        />
        <ContextViewerSurfaceController
          projectId="project"
          editorWorkId={workId}
          activeContextScheme={search.scheme ?? null}
          activeContextPath={search.path ?? null}
          active
          sidebarToggle={{ open: true, onExpand: vi.fn(), label: "Sidebar" }}
          dockToggle={{ open: true, onExpand: vi.fn(), label: "Dock" }}
          onSelectContextPath={vi.fn()}
          onOpenContextTarget={vi.fn()}
          onShowEditorRecents={vi.fn()}
        />
      </AccountFeatureTestProvider>
    );
  }

  await withReactRoot(<Harness />, async () => {
    expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
      selection: { status: "bound", identity: { documentId: older.documentId } },
      admitted: { scheme: "unfiled", path: "", workId: "work-a" },
    });
    expect(viewerProps?.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining(older), expect.objectContaining(newer)]),
    );

    await act(async () => selectWork?.("work-b"));
    expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
      selection: { status: "bound", identity: { documentId: chapter.documentId } },
      admitted: { scheme: "manuscript", path: "/a.md", workId: "work-b" },
    });
    expect(useContextTabsStore.getState().byProject.project?.selectedTabIdByWork["work-a"]).toBe(
      older.documentId,
    );

    await act(async () => selectWork?.("work-a"));
    expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
      selection: { status: "bound", identity: { documentId: older.documentId } },
      admitted: { scheme: "unfiled", path: "", workId: "work-a" },
    });
    expect(viewerProps?.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining(older), expect.objectContaining(newer)]),
    );
  });
});

it.each([
  ["loading", false, true],
  ["error with cached absence", true, false],
] as const)("preserves a route candidate during %s", async (_case, isError, isFetching) => {
  queryState.isError = isError;
  queryState.isFetching = isFetching;
  const route: ContextRemovalRoutePort = {
    transition: acceptContextTransition,
    readSearch: () => ({
      screen: "context",
      work: "work-1",
      scheme: "manuscript",
      path: "/missing.md",
    }),
    updateSearch: () => undefined,
  };

  await withReactRoot(
    <AccountFeatureTestProvider accountId={`account-${_case}`}>
      <CaptureCoordinator />
      <ProjectContextRemovalController
        projectId="project"
        activeScreen="context"
        activeContextScheme="manuscript"
        activeContextPath="/missing.md"
        editorWorkId="work-1"
        route={route}
      />
      <ContextViewerSurfaceController
        projectId="project"
        editorWorkId="work-1"
        activeContextScheme="manuscript"
        activeContextPath="/missing.md"
        active
        sidebarToggle={{ open: true, onExpand: vi.fn(), label: "Sidebar" }}
        dockToggle={{ open: true, onExpand: vi.fn(), label: "Dock" }}
        onSelectContextPath={vi.fn()}
        onOpenContextTarget={vi.fn()}
        onShowEditorRecents={vi.fn()}
      />
    </AccountFeatureTestProvider>,
    () => {
      if (!coordinator) throw new Error("coordinator did not mount");
      expect(coordinator.getProjectSnapshot("project")).toMatchObject({
        selection: { status: "candidate", locator: { path: "/missing.md" } },
        admitted: null,
      });
    },
  );
});

it("does not admit an old bound document while its retained controller is inactive", async () => {
  const locator = { scheme: "manuscript" as const, path: "/a.md", workId: "work-1" };
  function Harness() {
    return (
      <AccountFeatureTestProvider accountId="parked-account">
        <CaptureCoordinator />
        <ContextViewerSurfaceController
          projectId="project"
          editorWorkId="work-1"
          activeContextScheme="manuscript"
          activeContextPath="/a.md"
          active={false}
          sidebarToggle={{ open: true, onExpand() {}, label: "Sidebar" }}
          dockToggle={{ open: true, onExpand() {}, label: "Chat" }}
          onSelectContextPath={() => {
            throw new Error("Inactive navigation");
          }}
          onShowEditorRecents={vi.fn()}
          onOpenContextTarget={() => {
            throw new Error("Inactive navigation");
          }}
        />
      </AccountFeatureTestProvider>
    );
  }
  await withReactRoot(<Harness />, async () => {
    if (!coordinator) throw new Error("Coordinator did not mount");
    const lease = coordinator.createLifetimeLease();
    lease.resume();
    const host = coordinator.registerRoutePort(
      "project",
      {
        transition: acceptContextTransition,
        readSearch: () => ({
          screen: "context",
          work: "work-1",
          scheme: "manuscript",
          path: "/a.md",
        }),
        updateSearch() {},
      },
      "work-1",
    );
    try {
      await act(async () => {
        coordinator?.beginRouteSelection("project", locator);
        const revision = coordinator?.getProjectSnapshot("project").selection.revision;
        if (revision === undefined) throw new Error("Selection missing");
        coordinator?.bindRouteSelection("project", revision, { kind: "server", documentId: "a" });
      });
      expect(coordinator.getProjectSnapshot("project").admitted).toBeNull();
    } finally {
      host.release();
      lease.suspend();
      lease.disposeIfSuspended();
    }
  });
});
