// @vitest-environment jsdom
/** Receipt-order coverage through the mounted desktop route and desk composition. */

import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { type ContextTab, rehydrateContextDesks, useContextTabsStore } from "@/client/stores";
import { DeviceContextDeskStore } from "@/client/stores/context-tabs-store/context-desk-storage";
import { configureWorkingSetSync, hydrateWorkingSet } from "@/client/working-set";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { ContextViewerSurfaceController } from "../ContextPaneController";
import type { ProjectSearch } from "../routing/project-route";
import {
  ContextRemovalAccountProvider,
  useContextRemovalCoordinator,
} from "./ContextRemovalAccountProvider";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectContextRemovalController } from "./ProjectContextRemovalController";
import type { UntitledLifecycleRig as Rig } from "./test-support/UntitledLifecycleRig";

const reconcilerState = vi.hoisted(() => ({ rig: null as Rig | null }));
const transportState = vi.hoisted(() => ({
  revision: 0,
  reports: [] as Array<{ recentRoutes: unknown[] }>,
}));

vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/projects-api")>()),
  updateProjectWorkingSet: async (_projectId: string, report: { recentRoutes: unknown[] }) => {
    transportState.reports.push(structuredClone(report));
    transportState.revision += 1;
    return { revision: transportState.revision };
  },
}));

vi.mock("./untitled-reconciler-browser", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./untitled-reconciler-browser")>()),
  isUntitledPending: () => true,
  queueUntitledIdentity: (...args: Parameters<Rig["reconciler"]["queueIdentity"]>) =>
    reconcilerState.rig?.reconciler.queueIdentity(...args),
  registerUntitledCandidate: (...args: Parameters<Rig["reconciler"]["registerCandidate"]>) =>
    reconcilerState.rig?.reconciler.registerCandidate(...args) ?? (() => {}),
  syncUntitledReceiptOwners: () => {},
}));

const tree = {
  kind: "dir",
  name: "",
  path: "",
  children: [
    {
      kind: "file",
      name: "a.md",
      path: "/a.md",
      documentId: "chapter-b",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
    {
      kind: "file",
      name: "Opening.md",
      path: "/Act 1/Opening.md",
      documentId: "doc-1",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
  ],
};
vi.mock("@/client/query/useProjectContextTree", () => ({
  useProjectContextTree: (_projectId: string, scheme: ProjectContextTreeScheme) => ({
    tree: scheme === "manuscript" ? tree : { kind: "dir", name: "Scratch", path: "", children: [] },
    capabilities: null,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("./ContextViewer", () => ({ ContextViewer: () => null }));

const { UntitledLifecycleRig } = await import("./test-support/UntitledLifecycleRig");
const { useIdentityCommit } = await import("./use-identity-commit");

const NEW_TAB: ContextTab = {
  kind: "new",
  documentId: "doc-1",
  name: "Untitled",
  workId: "work-a",
};
const CHAPTER: ContextTab = {
  kind: "tracked",
  documentId: "chapter-b",
  scheme: "manuscript",
  path: "/a.md",
  name: "a.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

let coordinator: ContextRemovalCoordinator | null = null;
function CaptureCoordinator() {
  coordinator = useContextRemovalCoordinator();
  return null;
}

afterEach(() => {
  reconcilerState.rig = null;
  coordinator = null;
  transportState.reports.length = 0;
  transportState.revision = 0;
  localStorage.clear();
  useContextTabsStore.setState({ byProject: {}, _deskHydrated: false });
});

it.each([
  "receipt-after-transition",
  "receipt-before-transition",
] as const)("settles and restores the exact local owner through the production composition with %s", async (ordering) => {
  const rig = new UntitledLifecycleRig();
  reconcilerState.rig = rig;
  rig.start();
  const accountId = `${ordering}-${crypto.randomUUID()}`;
  configureWorkingSetSync(accountId, true);
  hydrateWorkingSet("project-1", { status: "absent" }, true);
  rehydrateContextDesks(accountId);
  useContextTabsStore.setState({
    byProject: {
      "project-1": {
        tabs: [CHAPTER, NEW_TAB],
        selectedTabIdByWork: { "work-a": NEW_TAB.documentId, "work-b": CHAPTER.documentId },
      },
    },
  });

  const rawWrites: Array<{ key: string; value: string }> = [];
  const originalSetItem = Storage.prototype.setItem;
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation((key: string, value: string) => {
      rawWrites.push({ key, value });
      return originalSetItem.call(localStorage, key, value);
    });
  let commit!: ReturnType<typeof useIdentityCommit>;
  let selectWork!: (workId: "work-a" | "work-b") => void;
  let search: ProjectSearch = {
    screen: "context",
    work: "work-a",
    scheme: "scratch",
    path: "",
  };

  function Harness() {
    const [route, setRoute] = useState(search);
    const workId = route.work as "work-a" | "work-b";
    selectWork = (next) => {
      const nextSearch: ProjectSearch =
        next === "work-a"
          ? { screen: "context", work: next, scheme: "scratch", path: "" }
          : { screen: "context", work: next, scheme: "manuscript", path: "/a.md" };
      search = nextSearch;
      setRoute(nextSearch);
    };
    commit = useIdentityCommit({
      projectId: "project-1",
      tab: NEW_TAB,
      editorWorkId: workId,
      identityMutations: rig.identityMutations,
      onCommitted: () => {},
    });
    const updateRoute = (path: string, scheme: ProjectContextTreeScheme = "scratch") => {
      search = { ...search, scheme, path };
      setRoute(search);
    };
    return (
      <ContextRemovalAccountProvider accountId={accountId}>
        <CaptureCoordinator />
        <ProjectContextRemovalController
          projectId="project-1"
          activeScreen="context"
          activeContextScheme={route.scheme ?? null}
          activeContextPath={route.path ?? null}
          editorWorkId={workId}
          route={{
            readSearch: () => search,
            updateSearch: (_projectId, update) => {
              search = update(search);
              setRoute(search);
            },
          }}
        />
        <ContextViewerSurfaceController
          projectId="project-1"
          editorWorkId={workId}
          activeContextScheme={route.scheme ?? null}
          activeContextPath={route.path ?? null}
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
    await withReactRoot(
      <QueryClientProvider client={rig.queryClient}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        expect(coordinator?.getProjectSnapshot("project-1")).toMatchObject({
          selection: { status: "bound", identity: { kind: "local", documentId: "doc-1" } },
          admitted: { scheme: "scratch", path: "", workId: "work-a" },
        });

        await act(async () => {
          await commit({
            name: "Opening.md",
            destination: { scheme: "manuscript", folderPath: "/Act 1" },
          });
        });
        if (ordering === "receipt-before-transition") {
          await act(async () => rig.advance());
          expect(search).toMatchObject({
            work: "work-a",
            scheme: "manuscript",
            path: "/Act 1/Opening.md",
          });
          expect(coordinator?.getProjectSnapshot("project-1")).toMatchObject({
            selection: { status: "bound", identity: { documentId: "doc-1" } },
            admitted: { scheme: "manuscript", path: "/Act 1/Opening.md", workId: "work-a" },
          });
        }
        await act(async () => selectWork("work-b"));
        expect(search).toMatchObject({ work: "work-b", scheme: "manuscript", path: "/a.md" });
        expect(coordinator?.getProjectSnapshot("project-1")).toMatchObject({
          selection: { status: "bound", identity: { documentId: "chapter-b" } },
          admitted: { scheme: "manuscript", path: "/a.md", workId: "work-b" },
        });

        if (ordering === "receipt-after-transition") await act(async () => rig.advance());
        expect(search).toMatchObject({ work: "work-b", scheme: "manuscript", path: "/a.md" });
        expect(useContextTabsStore.getState().byProject["project-1"]?.selectedTabIdByWork).toEqual({
          "work-a": "doc-1",
          "work-b": "chapter-b",
        });

        await act(async () => selectWork("work-a"));
        expect(search).toMatchObject({
          work: "work-a",
          scheme: "manuscript",
          path: "/Act 1/Opening.md",
        });
        expect(coordinator?.getProjectSnapshot("project-1")).toMatchObject({
          selection: { status: "bound", identity: { kind: "server", documentId: "doc-1" } },
          admitted: { scheme: "manuscript", path: "/Act 1/Opening.md", workId: "work-a" },
        });

        const rawDesk = localStorage.getItem("meridian:context-desk");
        expect(rawDesk).not.toBeNull();
        const reconstructed = new DeviceContextDeskStore(localStorage).setUser(accountId);
        expect(reconstructed["project-1"]).toMatchObject({
          selectedTabIdByWork: { "work-a": "doc-1", "work-b": "chapter-b" },
          tabs: expect.arrayContaining([
            expect.objectContaining({
              documentId: "doc-1",
              path: "/Act 1/Opening.md",
              origin: "local-untitled",
            }),
          ]),
        });
        useContextTabsStore.setState({ byProject: reconstructed, _deskHydrated: true });
        expect(coordinator?.getProjectSnapshot("project-1")).toMatchObject({
          selection: { status: "bound", identity: { documentId: "doc-1" } },
          admitted: { scheme: "manuscript", path: "/Act 1/Opening.md", workId: "work-a" },
        });

        expect(rig.create.calls[0]?.[0].home.workId).toBe("work-a");
        expect(
          rawWrites
            .filter(({ key }) => key === "meridian:working-set")
            .some(({ value }) => value.includes('"path":""')),
        ).toBe(false);
        const allWorkingSetRoutes = [
          ...rawWrites
            .filter(({ key }) => key === "meridian:working-set")
            .flatMap(({ value }) =>
              Object.values<{
                snapshot?: {
                  recentRoutes?: Array<{ scheme: string; path: string; workId?: string }>;
                };
              }>(JSON.parse(value).projects ?? {}).flatMap(
                (project) => project.snapshot?.recentRoutes ?? [],
              ),
            ),
          ...transportState.reports.flatMap(
            (report) =>
              report.recentRoutes as Array<{ scheme: string; path: string; workId?: string }>,
          ),
        ];
        expect(allWorkingSetRoutes.every((route) => route.path.length > 0)).toBe(true);
        expect(
          allWorkingSetRoutes.every(
            (route) => route.scheme !== "scratch" || route.workId === "work-a",
          ),
        ).toBe(true);
      },
    );
  } finally {
    setItem.mockRestore();
  }
});
