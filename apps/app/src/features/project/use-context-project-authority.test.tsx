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
import {
  AccountFeatureTestProvider,
  useContextRemovalCoordinator,
} from "@/test-support/account-feature-provider";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ContextRemovalCoordinator } from "./context/context-removal-coordinator";
import { ProjectContextRemovalController } from "./context/ProjectContextRemovalController";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import type { EditorWorkScope } from "./editor-work-scope";
import type { ProjectSearch } from "./routing/project-route";
import { useContextProjectAuthority } from "./use-context-project-authority";

const mocks = vi.hoisted(() => ({
  availability: vi.fn(),
  updateWorkingSet: vi.fn(),
  localSnapshots: [] as Array<{ projectId: string; snapshot: unknown; raw: string | null }>,
}));
vi.mock("@/client/query/project-context-availability", () => ({
  lookupProjectContextAvailability: mocks.availability,
}));
vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/projects-api")>()),
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
    byProject: { project: { tabs: [restored], selectedTabIdByWork: { "work-1": "restored" } } },
    _deskHydrated: true,
  });
});

it("withholds live hosts through one held raw bootstrap and never restores raw authority", async () => {
  const read = deferred<unknown>();
  mocks.availability.mockImplementation(() => read.promise);
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
      expect(mocks.availability).toHaveBeenCalledOnce();

      await act(async () =>
        read.resolve({
          projectId: "project",
          resolutionId: "lookup-1",
          resolutions: [{ kind: "not-visible", documentId: "restored", checkedGeneration: "1" }],
        }),
      );
      expect(document.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("live");
      expect(useContextTabsStore.getState().byProject.project?.tabs).toEqual([]);

      useContextTabsStore.setState({
        byProject: { project: { tabs: [restored], selectedTabIdByWork: { "work-1": "restored" } } },
      });
      await act(async () => setWork?.({ status: "loading", workId: "work-1" }));
      expect(document.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("suspended");
      await act(async () => setWork?.({ status: "ready", workId: "work-2", source: "route" }));
      expect(document.querySelector("[data-phase]")?.getAttribute("data-phase")).toBe("live");
      expect(mocks.availability).toHaveBeenCalledOnce();
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
    byProject: {
      project: { tabs: [deleted, knowledge], selectedTabIdByWork: { "work-1": "deleted" } },
    },
    _deskHydrated: true,
  });
  const read = deferred<unknown>();
  mocks.availability.mockImplementation(() => read.promise);
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
      { documentId: "deleted", scheme: "kb", path: "/deleted.md" },
      { documentId: "knowledge", scheme: "kb", path: "/knowledge.md" },
    ],
    promote: { documentId: "deleted", scheme: "kb", path: "/deleted.md" },
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
      <AccountFeatureTestProvider accountId="bootstrap-account">
        <Harness />
      </AccountFeatureTestProvider>,
      async () => {
        expect(document.querySelector("[data-phase]")?.textContent).toBe("withheld");
        expect(useContextTabsStore.getState().byProject.project?.tabs).toHaveLength(2);

        await act(async () =>
          read.resolve({
            projectId: "project",
            resolutionId: "lookup-2",
            resolutions: [
              { kind: "not-visible", documentId: "deleted", checkedGeneration: "1" },
              {
                kind: "available",
                documentId: "knowledge",
                generation: "1",
                authority: { kind: "project", projectId: "project" },
                entry: {
                  kind: "file",
                  entryId: "knowledge",
                  scope: { kind: "project", projectId: "project" },
                  sourceId: "kb-source",
                  parentId: "kb-source",
                  aliases: [],
                  path: ["knowledge.md"],
                  uri: "kb://knowledge.md",
                  name: "knowledge.md",
                  editable: true,
                  filetype: "markdown",
                  schemaType: "document",
                  provisionalName: false,
                },
              },
            ],
          }),
        );

        expect(document.querySelector("[data-phase]")?.textContent).toBe("live");
        expect(useContextTabsStore.getState().byProject.project).toMatchObject({
          tabs: [expect.objectContaining({ documentId: "knowledge" })],
          selectedTabIdByWork: { "work-1": "knowledge" },
        });
        expect(coordinator?.getProjectSnapshot("project")).toMatchObject({
          selection: { status: "rejected", locator: { path: "/deleted.md" } },
          admitted: { path: "/knowledge.md" },
        });
        expect(readRecentRoutes("project")).toEqual([
          { documentId: "knowledge", scheme: "kb", path: "/knowledge.md" },
        ]);
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
