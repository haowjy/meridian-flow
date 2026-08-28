// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { act, StrictMode, useLayoutEffect, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import {
  configureWorkingSetSync,
  hydrateWorkingSet,
  readRecentRoutes,
  reconcileContextRoutes,
} from "@/client/working-set/driver";
import { DeviceWorkingSetStore, WORKING_SET_STORAGE_KEY } from "@/client/working-set/store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  ContextRemovalAccountProvider,
  useContextRemovalCoordinator,
} from "./context/ContextRemovalAccountProvider";
import type { ContextRemovalCoordinator } from "./context/context-removal-coordinator";
import { ProjectContextRemovalController } from "./context/ProjectContextRemovalController";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import type { EditorWorkScope } from "./editor-work-scope";
import type { ProjectSearch } from "./routing/project-route";
import { useContextProjectAuthority } from "./use-context-project-authority";

const mocks = vi.hoisted(() => ({
  readTree: vi.fn(),
  updateWorkingSet: vi.fn(),
  localSnapshots: [] as Array<{ projectId: string; snapshot: unknown; raw: string | null }>,
}));
vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/projects-api")>()),
  getProjectContextTree: mocks.readTree,
  updateProjectWorkingSet: mocks.updateWorkingSet,
}));

const workingSetStorage = window.localStorage;
configureWorkingSetSync("project-authority-bootstrap", false);

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const restored = {
  kind: "tracked" as const,
  documentId: "restored",
  scheme: "kb" as const,
  path: "/restored.md",
  name: "restored.md",
  editable: true as const,
  filetype: "markdown" as const,
  schemaType: "document" as const,
};
const disabledHydration = { status: "disabled" as const };

beforeEach(() => {
  useContextTabsStore.setState({
    byProject: { project: { tabs: [restored], activeTabId: "restored" } },
    _deskHydrated: true,
  });
});

it("withholds live hosts through one held raw bootstrap and never restores raw authority", async () => {
  const read = deferred<{
    tree: { kind: "dir"; path: string; name: string; children: [] };
    capabilities: null;
  }>();
  mocks.readTree.mockImplementation(() => read.promise);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let setWork: ((work: EditorWorkScope) => void) | null = null;

  function Harness() {
    const [work, updateWork] = useState<EditorWorkScope>({
      status: "ready",
      workId: "work-1",
      source: "route",
    });
    setWork = updateWork;
    const phase = useContextProjectAuthority({
      projectId: "project",
      deskHydrated: true,
      editorScope: work,
      workingSetHydration: disabledHydration,
      queryClient,
    });
    return <div data-phase={phase.status}>{phase.status === "live" ? "host" : "withheld"}</div>;
  }

  await withReactRoot(
    <StrictMode>
      <Harness />
    </StrictMode>,
    async () => {
      expect(document.querySelector("[data-phase]")?.textContent).toBe("withheld");
      expect(mocks.readTree).toHaveBeenCalledOnce();

      await act(async () =>
        read.resolve({
          tree: { kind: "dir", path: "/", name: "Knowledge Base", children: [] },
          capabilities: null,
        }),
      );
      expect(document.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("live");
      expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([]);

      useContextTabsStore.setState({
        byProject: { project: { tabs: [restored], activeTabId: "restored" } },
      });
      await act(async () => setWork?.({ status: "loading", workId: "work-1" }));
      expect(document.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("suspended");
      await act(async () => setWork?.({ status: "ready", workId: "work-2", source: "route" }));
      expect(document.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("live");
      expect(mocks.readTree).toHaveBeenCalledOnce();
      expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([restored]);
    },
  );
});

it("keeps a fulfilled bootstrap removal authoritative when the explicit live route starts", async () => {
  const deleted = { ...restored, documentId: "deleted", path: "/deleted.md", name: "deleted.md" };
  const knowledge = {
    ...restored,
    documentId: "knowledge",
    path: "/knowledge.md",
    name: "knowledge.md",
  };
  useContextTabsStore.setState({
    byProject: { project: { tabs: [deleted, knowledge], activeTabId: "deleted" } },
    _deskHydrated: true,
  });
  const read = deferred<{
    tree: {
      kind: "dir";
      path: string;
      name: string;
      children: Array<{
        kind: "file";
        path: string;
        name: string;
        documentId: string;
        editable: true;
        filetype: "markdown";
        schemaType: "document";
      }>;
    };
    capabilities: null;
  }>();
  mocks.readTree.mockImplementation(() => read.promise);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  let coordinator: ContextRemovalCoordinator | null = null;
  let search: ProjectSearch = {
    screen: "context" as const,
    work: "work-1",
    scheme: "kb" as const,
    path: "/deleted.md",
  };
  const emittedReports: Array<{ recentRoutes: unknown[] }> = [];
  let serverRevision = 0;
  mocks.updateWorkingSet.mockImplementation(
    async (_projectId: string, snapshot: { recentRoutes: unknown[] }) => {
      emittedReports.push(structuredClone(snapshot));
      serverRevision += 1;
      return { revision: serverRevision };
    },
  );
  workingSetStorage.removeItem(WORKING_SET_STORAGE_KEY);
  configureWorkingSetSync("bootstrap-account", true);
  hydrateWorkingSet("project", { status: "absent" }, true);
  reconcileContextRoutes("project", {
    removedLocators: [],
    survivingOwnedLocators: [
      { scheme: "kb", path: "/deleted.md" },
      { scheme: "kb", path: "/knowledge.md" },
    ],
    promote: { scheme: "kb", path: "/deleted.md" },
    clearAll: false,
  });
  mocks.localSnapshots.length = 0;
  const originalReport = DeviceWorkingSetStore.prototype.report;
  const reportSpy = vi
    .spyOn(DeviceWorkingSetStore.prototype, "report")
    .mockImplementation(function (this: DeviceWorkingSetStore, ...args) {
      const changed = originalReport.apply(this, args);
      mocks.localSnapshots.push({
        projectId: args[0],
        snapshot: structuredClone(this.read(args[0])?.snapshot),
        raw: workingSetStorage.getItem(WORKING_SET_STORAGE_KEY),
      });
      return changed;
    });
  function RejectingMaterializer() {
    const service = useContextRemovalCoordinator();
    const snapshot = useContextRemovalProject("project");
    useLayoutEffect(() => {
      if (snapshot.selection.status !== "candidate") return;
      service.rejectRouteCandidate("project", snapshot.selection.revision);
    }, [service, snapshot.selection]);
    return null;
  }
  function Harness() {
    coordinator = useContextRemovalCoordinator();
    const phase = useContextProjectAuthority({
      projectId: "project",
      deskHydrated: true,
      editorScope: { status: "ready", workId: "work-1", source: "route" },
      workingSetHydration: disabledHydration,
      queryClient,
    });
    if (phase.status !== "live") return <div data-phase={phase.status}>withheld</div>;
    return (
      <>
        <div data-phase="live">live</div>
        <ProjectContextRemovalController
          projectId="project"
          activeScreen="context"
          activeContextScheme="kb"
          activeContextPath="/deleted.md"
          editorWorkId="work-1"
          route={{
            readSearch: () => search,
            updateSearch: (_projectId, update) => {
              search = update(search);
            },
          }}
        />
        <RejectingMaterializer />
      </>
    );
  }

  try {
    await withReactRoot(
      <ContextRemovalAccountProvider accountId="bootstrap-account">
        <Harness />
      </ContextRemovalAccountProvider>,
      async () => {
        expect(document.querySelector("[data-phase]")?.textContent).toBe("withheld");
        expect(useContextTabsStore.getState().byProject.project?.tabs).toHaveLength(2);

        await act(async () =>
          read.resolve({
            tree: {
              kind: "dir",
              path: "/",
              name: "Knowledge Base",
              children: [
                {
                  kind: "file",
                  path: "/knowledge.md",
                  name: "knowledge.md",
                  documentId: "knowledge",
                  editable: true,
                  filetype: "markdown",
                  schemaType: "document",
                },
              ],
            },
            capabilities: null,
          }),
        );

        expect(document.querySelector("[data-phase]")?.textContent).toBe("live");
        expect(useContextTabsStore.getState().byProject.project).toMatchObject({
          tabs: [expect.objectContaining({ documentId: "knowledge" })],
          activeTabId: "knowledge",
        });
        expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
          selection: { status: "rejected", locator: { path: "/deleted.md" } },
          admitted: { path: "/knowledge.md" },
        });
        expect(readRecentRoutes("project")).toEqual([{ scheme: "kb", path: "/knowledge.md" }]);
        expect(search).toMatchObject({ scheme: "kb", path: "/knowledge.md" });
        const rawWorkingSet = workingSetStorage.getItem(WORKING_SET_STORAGE_KEY);
        expect(rawWorkingSet).not.toBeNull();
        expect(rawWorkingSet).not.toContain("/deleted.md");
        const restoredStore = new DeviceWorkingSetStore(workingSetStorage);
        restoredStore.setUser("bootstrap-account");
        expect(restoredStore.read("project")?.snapshot.recentRoutes ?? []).not.toContainEqual(
          expect.objectContaining({ path: "/deleted.md" }),
        );
        expect(mocks.localSnapshots.length).toBeGreaterThan(0);
        expect(mocks.localSnapshots.every((sample) => sample.raw !== null)).toBe(true);
        expect(
          mocks.localSnapshots.every(
            (snapshot) => !JSON.stringify(snapshot).includes("/deleted.md"),
          ),
        ).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 3_100));
        expect(emittedReports.length).toBeGreaterThan(0);
        expect(
          emittedReports.every((report) => !JSON.stringify(report).includes("/deleted.md")),
        ).toBe(true);
      },
    );
  } finally {
    reportSpy.mockRestore();
    configureWorkingSetSync("bootstrap-account", false);
  }
});
