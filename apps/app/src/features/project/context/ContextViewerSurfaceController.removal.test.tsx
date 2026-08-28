// @vitest-environment jsdom
/** Production desktop route materialization under a pending removal repair. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { act, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { type ContextTab, rehydrateContextDesks, useContextTabsStore } from "@/client/stores";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextViewerSurfaceController } from "../ContextPaneController";
import type { ProjectSearch } from "../routing/project-route";
import {
  ContextRemovalAccountProvider,
  useContextRemovalCoordinator,
} from "./ContextRemovalAccountProvider";
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
  capabilities: null,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
};

vi.mock("@/client/query/useProjectContextTree", () => ({
  useProjectContextTree: () => queryState,
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
vi.mock("./useUntitledTabBridge", () => ({ useUntitledTabBridge: () => undefined }));
const untitledMocks = vi.hoisted(() => ({ append: vi.fn(), isPending: vi.fn(() => false) }));
vi.mock("./untitled-reconciler-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./untitled-reconciler-browser")>()),
  appendPendingUntitled: untitledMocks.append,
  isUntitledPending: untitledMocks.isPending,
}));

let coordinator: ContextRemovalCoordinator | null = null;

function CaptureCoordinator() {
  coordinator = useContextRemovalCoordinator();
  return null;
}

beforeEach(() => {
  coordinator = null;
  viewerProps = null;
  untitledMocks.append.mockClear();
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
    _deskHydrated: true,
  });
});

it("persists and admits the real New action without an empty working-set route", async () => {
  localStorage.clear();
  const writes: Array<{ key: string; value: string }> = [];
  const originalSetItem = Storage.prototype.setItem;
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation((key: string, value: string) => {
      writes.push({ key, value });
      return originalSetItem.call(localStorage, key, value);
    });
  useContextTabsStore.setState({ byProject: {}, _deskHydrated: false });
  rehydrateContextDesks(`new-action-${crypto.randomUUID()}`);
  let search: ProjectSearch = { screen: "context", work: "work-a" };
  let releaseScratchRoute: (() => void) | null = null;

  function Harness() {
    const [route, setRoute] = useState<{
      scheme: ProjectContextTreeScheme | null;
      path: string | null;
    }>({
      scheme: null,
      path: null,
    });
    const updateRoute = (path: string, scheme: ProjectContextTreeScheme = "scratch") => {
      const commit = () => {
        search = { ...search, scheme, path };
        setRoute({ scheme, path });
      };
      if (scheme === "scratch" && path === "") releaseScratchRoute = commit;
      else commit();
    };
    return (
      <ContextRemovalAccountProvider accountId="new-action-account">
        <CaptureCoordinator />
        <ProjectContextRemovalController
          projectId="project"
          activeScreen="context"
          activeContextScheme={route.scheme}
          activeContextPath={route.path}
          editorWorkId="work-a"
          route={{
            readSearch: () => search,
            updateSearch: (_projectId, update) => {
              search = update(search);
              setRoute({
                scheme: search.scheme === "scratch" ? "scratch" : null,
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
          onOpenContextTarget={(target) => updateRoute(target.path, target.scheme)}
        />
      </ContextRemovalAccountProvider>
    );
  }

  try {
    await withReactRoot(<Harness />, async () => {
      await act(async () => viewerProps?.onNewDocument());
      const slice = useContextTabsStore.getState().byProject.project;
      const local = slice?.tabs.find((tab) => tab.kind === "new");
      expect(local).toBeDefined();
      expect(slice?.selectedTabIdByWork["work-a"]).toBe(local?.documentId);
      await act(async () => releaseScratchRoute?.());
      expect(search).toMatchObject({ scheme: "scratch", path: "" });
      expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
        selection: { status: "bound", identity: { kind: "local", documentId: local?.documentId } },
        admitted: { scheme: "scratch", path: "", workId: "work-a" },
      });
      const deskWrites = writes
        .filter((write) => write.key === "meridian:context-desk")
        .map((write) => JSON.parse(write.value));
      expect(deskWrites.length).toBeGreaterThan(0);
      expect(deskWrites.every((desk) => desk.version === 2)).toBe(true);
      expect(deskWrites.at(-1)?.projects.project).toMatchObject({
        selectedTabIdByWork: { "work-a": local?.documentId },
      });
      expect(deskWrites.at(-1)?.projects.project.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "new",
            documentId: local?.documentId,
            workId: "work-a",
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
    setItem.mockRestore();
  }
});

it("guarded-redirects a selected materialized local owner before admitting its server route", async () => {
  const materialized: ContextTab = {
    kind: "tracked",
    documentId: "local-a",
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
      project: { tabs: [materialized], selectedTabIdByWork: { "work-a": materialized.documentId } },
    },
    _deskHydrated: true,
  });
  let search: ProjectSearch = {
    screen: "context",
    work: "work-a",
    scheme: "scratch",
    path: "",
  };

  function Harness() {
    const [path, setPath] = useState("");
    return (
      <ContextRemovalAccountProvider accountId="materialized-redirect-account">
        <CaptureCoordinator />
        <ProjectContextRemovalController
          projectId="project"
          activeScreen="context"
          activeContextScheme="scratch"
          activeContextPath={path}
          editorWorkId="work-a"
          route={{
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
          activeContextScheme="scratch"
          activeContextPath={path}
          active
          sidebarToggle={{ open: true, onExpand: vi.fn(), label: "Sidebar" }}
          dockToggle={{ open: true, onExpand: vi.fn(), label: "Dock" }}
          onSelectContextPath={vi.fn()}
          onOpenContextTarget={vi.fn()}
        />
      </ContextRemovalAccountProvider>
    );
  }

  await withReactRoot(<Harness />, async () => {
    expect(search.path).toBe("/Untitled.md");
    expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
      selection: { status: "bound", identity: { documentId: materialized.documentId } },
      admitted: { scheme: "scratch", path: "/Untitled.md", workId: "work-a" },
    });
  });
});

it("restores the exact older local owner across A to B to A through mounted controllers", async () => {
  const older: ContextTab = {
    kind: "new",
    documentId: "untitled-older",
    name: "Untitled",
    workId: "work-a",
  };
  const newer: ContextTab = { ...older, documentId: "untitled-newer" };
  const chapter = useContextTabsStore.getState().byProject.project?.tabs[0] as ContextTab;
  useContextTabsStore.setState({
    byProject: {
      project: {
        tabs: [chapter, older, newer],
        selectedTabIdByWork: { "work-a": older.documentId, "work-b": chapter.documentId },
      },
    },
    _deskHydrated: true,
  });
  let selectWork: ((workId: string) => void) | null = null;
  let search: ProjectSearch = {
    screen: "context",
    work: "work-a",
    scheme: "scratch",
    path: "",
  };

  function Harness() {
    const [workId, setWorkId] = useState("work-a");
    selectWork = (next) => {
      search =
        next === "work-a"
          ? { screen: "context", work: next, scheme: "scratch", path: "" }
          : { screen: "context", work: next, scheme: "manuscript", path: "/a.md" };
      setWorkId(next);
    };
    return (
      <ContextRemovalAccountProvider accountId="untitled-owner-account">
        <CaptureCoordinator />
        <ProjectContextRemovalController
          projectId="project"
          activeScreen="context"
          activeContextScheme={search.scheme ?? null}
          activeContextPath={search.path ?? null}
          editorWorkId={workId}
          route={{
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
        />
      </ContextRemovalAccountProvider>
    );
  }

  await withReactRoot(<Harness />, async () => {
    expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
      selection: { status: "bound", identity: { documentId: older.documentId } },
      admitted: { scheme: "scratch", path: "", workId: "work-a" },
    });
    expect(viewerProps?.tabs).toEqual(expect.arrayContaining([older, newer]));

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
      admitted: { scheme: "scratch", path: "", workId: "work-a" },
    });
    expect(viewerProps?.tabs).toEqual(expect.arrayContaining([older, newer]));
  });
});

it.each([
  ["loading", false, true],
  ["error with cached absence", true, false],
] as const)("preserves a route candidate during %s", async (_case, isError, isFetching) => {
  queryState.isError = isError;
  queryState.isFetching = isFetching;
  const route: ContextRemovalRoutePort = {
    readSearch: () => ({
      screen: "context",
      work: "work-1",
      scheme: "manuscript",
      path: "/missing.md",
    }),
    updateSearch: () => undefined,
  };

  await withReactRoot(
    <ContextRemovalAccountProvider accountId={`account-${_case}`}>
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
      />
    </ContextRemovalAccountProvider>,
    () => {
      if (!coordinator) throw new Error("coordinator did not mount");
      expect(coordinator.getProjectSnapshot("project")).toMatchObject({
        selection: { status: "candidate", locator: { path: "/missing.md" } },
        admitted: null,
      });
    },
  );
});

it.each([
  "delayed",
  "failed",
] as const)("does not reopen cached A while %s route repair leaves the old URL visible", async () => {
  const search = {
    screen: "context" as const,
    work: "work-1",
    scheme: "manuscript" as const,
    path: "/a.md",
  };
  let delayedUpdate: ((latest: typeof search) => typeof search) | null = null;
  const route: ContextRemovalRoutePort = {
    readSearch: () => search,
    updateSearch: (_projectId, update) => {
      delayedUpdate = update as (latest: typeof search) => typeof search;
    },
  };

  await withReactRoot(
    <ContextRemovalAccountProvider accountId="account-1">
      <CaptureCoordinator />
      <ProjectContextRemovalController
        projectId="project"
        activeScreen="context"
        activeContextScheme="manuscript"
        activeContextPath="/a.md"
        editorWorkId="work-1"
        route={route}
      />
      <ContextViewerSurfaceController
        projectId="project"
        editorWorkId="work-1"
        activeContextScheme="manuscript"
        activeContextPath="/a.md"
        active
        sidebarToggle={{ open: true, onExpand: vi.fn(), label: "Sidebar" }}
        dockToggle={{ open: true, onExpand: vi.fn(), label: "Dock" }}
        onSelectContextPath={vi.fn()}
        onOpenContextTarget={vi.fn()}
      />
    </ContextRemovalAccountProvider>,
    async () => {
      const service = coordinator;
      if (!service) throw new Error("coordinator did not mount");
      const capture = service.captureDeleteInitiation("project", {
        kind: "file",
        locator: { scheme: "manuscript", path: "/a.md", workId: "work-1" },
        documentId: "a",
      });
      await act(async () => {
        service.acceptAcknowledgedDelete({
          ...capture,
          cause: "acknowledged-delete",
          confirmed: { status: "deleted", deletedDocumentIds: ["a"] },
        });
      });

      expect(delayedUpdate).not.toBeNull();
      expect(search.path).toBe("/a.md");
      expect(useContextTabsStore.getState().byProject.project).toMatchObject({
        tabs: [],
        selectedTabIdByWork: {},
      });
      expect(service.getProjectSnapshot("project")).toMatchObject({
        live: true,
        removalFence: { removedDocumentIds: ["a"] },
        admitted: null,
      });
    },
  );
});
