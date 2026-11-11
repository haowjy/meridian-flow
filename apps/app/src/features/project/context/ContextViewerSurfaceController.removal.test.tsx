// @vitest-environment jsdom
/** Production desktop route materialization under a pending removal repair. */

import { acceptContextTransition } from "@/test-support/context-removal-route";
import "fake-indexeddb/auto";

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { act, useLayoutEffect, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  type ContextTab,
  rehydrateEditorWorkspace,
  selectedDocumentIdOf,
  useContextTabsStore,
} from "@/client/stores";
import {
  AccountFeatureTestProvider,
  useAccountResourceReplica,
  useContextRemovalCoordinator,
} from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  type ContextViewerSurfaceControllerProps,
  ContextViewerSurfaceController as ResolvedController,
} from "../ContextPaneController";
import { useDesktopEditorPresentation } from "../DesktopProjectController";

function ContextViewerSurfaceController(
  props: Omit<ContextViewerSurfaceControllerProps, "resolvedEditor">,
) {
  const presentation = useDesktopEditorPresentation({
    projectId: props.projectId,
    current: props.editorWorkId ? { ...props, editorWorkId: props.editorWorkId } : null,
    requestedWorkId: props.editorWorkId,
    screen: "context",
    contextLive: props.active,
  });
  return <ResolvedController {...props} resolvedEditor={presentation.resolved} />;
}

import type { ProjectSearch } from "../routing/project-route";
import { useOptionalDraftOnlyPresentations } from "./account-feature-context";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
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
  paneState: { kind: string; settledTab?: ContextTab | null };
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
            tabInstanceId: "instance-a",
            scheme: "manuscript",
            path: "/a.md",
            name: "a.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
        selectedTabKey: "instance-a",
      },
    },
    _workspaceHydrated: false,
  });
});

const shellProps = {
  editorWork: null,
  sidebarToggle: { open: true, onExpand: vi.fn(), label: "Sidebar" },
  dockToggle: { open: true, onExpand: vi.fn(), label: "Dock" },
  onSelectContextPath: vi.fn(),
  onOpenContextTarget: vi.fn(),
  onShowEditorRecents: vi.fn(),
  routeDisplayed: true,
  mask: {},
};

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
  let restoreTabStorage = () => {};
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
  let search: ProjectSearch = { screen: "context" };
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
          {...shellProps}
          projectId="project"
          editorWorkId="work-a"
          activeContextScheme={route.scheme}
          activeContextPath={route.path}
          active
          onSelectContextPath={updateRoute}
          onOpenContextTarget={(target, options) =>
            new Promise((resolve) => {
              releaseLocalRoute = () => {
                if (options?.tab) {
                  useContextTabsStore.getState().openTab("project", options.tab);
                  void useContextTabsStore.getState().selectTab("project", options.tab.documentId);
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
      // The harness creates a new window; its sessionStorage has its own realm.
      const tabStoragePrototype = Object.getPrototypeOf(window.sessionStorage) as Storage;
      const tabSetItem = tabStoragePrototype.setItem;
      const tabSpy = vi.spyOn(tabStoragePrototype, "setItem").mockImplementation(function (
        this: Storage,
        key: string,
        value: string,
      ) {
        writes.push({ key, value });
        return tabSetItem.call(this, key, value);
      });
      restoreTabStorage = () => tabSpy.mockRestore();
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
      expect(slice && selectedDocumentIdOf(slice)).toBe(local?.documentId);
      expect(search).toMatchObject({ scheme: "unfiled", path: "" });
      expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
        selection: { status: "bound", identity: { kind: "local", documentId: local?.documentId } },
        admitted: { scheme: "unfiled", path: "" },
      });
      const workspaceWrites = writes
        .filter((write) => write.key === "meridian:editor-workspace:v2")
        .map((write) => JSON.parse(write.value));
      expect(workspaceWrites.length).toBeGreaterThan(0);
      expect(workspaceWrites.every((workspace) => workspace.version === 4)).toBe(true);
      expect(workspaceWrites.at(-1)?.payload.project).toMatchObject({
        selectedTabKey: local?.tabInstanceId,
      });
      expect(workspaceWrites.at(-1)?.payload.project.tabs).toEqual(
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
    restoreTabStorage();
    setItem.mockRestore();
    Object.defineProperty(navigator, "locks", { configurable: true, value: originalLocks });
    vi.unstubAllGlobals();
    expect(reportedErrors).toEqual([]);
  }
});

it("does not admit an old bound document while its retained controller is inactive", async () => {
  const locator = { scheme: "manuscript" as const, path: "/a.md" };
  function Harness() {
    return (
      <AccountFeatureTestProvider accountId="parked-account">
        <CaptureCoordinator />
        <ContextViewerSurfaceController
          {...shellProps}
          projectId="project"
          editorWorkId="work-1"
          activeContextScheme="manuscript"
          activeContextPath="/a.md"
          active={false}
          sidebarToggle={{ open: true }}
          dockToggle={{ open: true }}
          onSelectContextPath={() => {
            throw new Error("Inactive navigation");
          }}
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
        coordinator?.bindRouteSelection(
          "project",
          revision,
          { kind: "server", documentId: "a" },
          "answer",
        );
      });
      expect(coordinator.getProjectSnapshot("project").admitted).toBeNull();
    } finally {
      host.release();
      lease.suspend();
      lease.disposeIfSuspended();
    }
  });
});

it("a plain path settles on another Work's hidden draft-created document never", async () => {
  useContextTabsStore.setState({
    byProject: {
      project: {
        tabs: [
          {
            kind: "tracked",
            documentId: "a",
            tabInstanceId: "instance-a",
            scheme: "manuscript",
            path: "/a.md",
            name: "a.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
        selectedTabKey: "instance-a",
      },
    },
    _workspaceHydrated: false,
  });
  queryState.isFetching = true;
  await withReactRoot(
    <AccountFeatureTestProvider accountId="account-a">
      <PresentDraftOnly />
      <ContextViewerSurfaceController
        {...shellProps}
        projectId="project"
        editorWorkId="work-2"
        activeContextScheme="manuscript"
        activeContextPath="/a.md"
        active
      />
    </AccountFeatureTestProvider>,
    async () => {
      // Work 1's draft-created page is not reached by a plain path under Work 2: only an address
      // with its owner and item names it.
      expect(viewerProps?.paneState).toMatchObject({
        kind: "optimistic-loading",
        settledTab: null,
      });
    },
  );
});

/** Work 1's review host presents document `a`, a page its draft created. */
function PresentDraftOnly() {
  const registry = useOptionalDraftOnlyPresentations();
  useLayoutEffect(() => {
    registry?.present({
      projectId: "project",
      documentId: "a",
      ownerKey: "work:work-1",
      itemKey: "draft-1",
      token: "token",
      contextLocation: { scheme: "manuscript", path: "/a.md" },
    });
  }, [registry]);
  return null;
}
