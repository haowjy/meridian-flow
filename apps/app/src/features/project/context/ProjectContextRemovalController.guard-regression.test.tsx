// @vitest-environment jsdom
/** Production-controller guard regression over the browser working-set adapter. */

import { act, useLayoutEffect, useState } from "react";
import { expect, it, vi } from "vitest";
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
import type { ProjectSearch } from "../routing/project-route";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectContextRemovalController } from "./ProjectContextRemovalController";
import { useContextRemovalProject } from "./use-context-removal-project";

const workingSetSync = vi.hoisted(() => ({
  put: vi.fn(),
  localSnapshots: [] as Array<{ projectId: string; snapshot: unknown; raw: string | null }>,
}));
vi.mock("@/client/api/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/client/api/projects-api")>()),
  updateProjectWorkingSet: workingSetSync.put,
}));

const workingSetStorage = window.localStorage;
configureWorkingSetSync("guard-regression-bootstrap", false);

function RejectingMaterializer({ projectId }: { projectId: string }) {
  const coordinator = useContextRemovalCoordinator();
  const snapshot = useContextRemovalProject(projectId);
  useLayoutEffect(() => {
    if (snapshot.selection.status !== "candidate") return;
    coordinator.rejectRouteCandidate(projectId, snapshot.selection.revision);
  }, [coordinator, projectId, snapshot.selection]);
  return null;
}

it("never restamps a Work-scoped route candidate during a production Work transition", async () => {
  const projectId = "work-restamp-project";
  const accountId = "work-restamp-account";
  const wrongPath = "/work-2.md";
  useContextTabsStore.setState({
    byProject: {
      [projectId]: {
        tabs: [
          {
            kind: "tracked",
            documentId: "knowledge",
            scheme: "kb",
            path: "/knowledge.md",
            name: "knowledge.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
          {
            kind: "tracked",
            documentId: "work-2-document",
            scheme: "scratch",
            path: wrongPath,
            name: "work-2.md",
            workId: "work-2",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
        selectedTabIdByWork: { "work-1": "work-2-document" },
      },
    },
    _deskHydrated: true,
  });
  let coordinator: ContextRemovalCoordinator | null = null;
  let switchWork: (() => void) | null = null;
  let search: ProjectSearch = {
    screen: "context",
    work: "work-2",
    scheme: "scratch",
    path: wrongPath,
  };
  const route = {
    readSearch: () => search,
    updateSearch: (_projectId: string, update: (latest: ProjectSearch) => ProjectSearch) => {
      search = update(search);
    },
  };
  const emittedReports: Array<{ recentRoutes: unknown[] }> = [];
  let serverRevision = 0;
  let reportSpy: ReturnType<typeof vi.spyOn> | null = null;
  workingSetSync.put.mockImplementation(
    async (_projectId: string, snapshot: { recentRoutes: unknown[] }) => {
      emittedReports.push(structuredClone(snapshot));
      serverRevision += 1;
      return { revision: serverRevision };
    },
  );
  function Capture() {
    coordinator = useContextRemovalCoordinator();
    return null;
  }
  function SeedWorkingSet() {
    useLayoutEffect(() => {
      workingSetStorage.removeItem(WORKING_SET_STORAGE_KEY);
      configureWorkingSetSync(accountId, true);
      hydrateWorkingSet(projectId, { status: "absent" }, true);
      reconcileContextRoutes(projectId, {
        removedLocators: [],
        survivingOwnedLocators: [
          { documentId: "knowledge", scheme: "kb", path: "/knowledge.md" },
          { documentId: "document-route", scheme: "scratch", path: wrongPath, workId: "work-2" },
        ],
        promote: {
          documentId: "document-route",
          scheme: "scratch",
          path: wrongPath,
          workId: "work-2",
        },
        clearAll: false,
      });
      const originalReport = DeviceWorkingSetStore.prototype.report;
      reportSpy = vi.spyOn(DeviceWorkingSetStore.prototype, "report").mockImplementation(function (
        this: DeviceWorkingSetStore,
        ...args
      ) {
        const changed = originalReport.apply(this, args);
        workingSetSync.localSnapshots.push({
          projectId: args[0],
          snapshot: structuredClone(this.read(args[0])?.snapshot),
          raw: workingSetStorage.getItem(WORKING_SET_STORAGE_KEY),
        });
        return changed;
      });
      reconcileContextRoutes(projectId, {
        removedLocators: [],
        survivingOwnedLocators: [{ documentId: "knowledge", scheme: "kb", path: "/knowledge.md" }],
        promote: { documentId: "knowledge", scheme: "kb", path: "/knowledge.md" },
        clearAll: false,
      });
    }, []);
    return null;
  }
  function Harness() {
    const [workId, setWorkId] = useState("work-2");
    switchWork = () => {
      search = { ...search, work: "work-1" };
      setWorkId("work-1");
    };
    return (
      <AccountFeatureTestProvider accountId={accountId}>
        <SeedWorkingSet />
        <Capture />
        <ProjectContextRemovalController
          projectId={projectId}
          activeScreen="context"
          activeContextScheme="scratch"
          activeContextPath={wrongPath}
          editorWorkId={workId}
          route={route}
        />
        {workId === "work-1" ? <RejectingMaterializer projectId={projectId} /> : null}
      </AccountFeatureTestProvider>
    );
  }

  try {
    await withReactRoot(<Harness />, async () => {
      workingSetSync.localSnapshots.length = 0;
      emittedReports.length = 0;
      await act(async () => switchWork?.());

      expect(useContextTabsStore.getState().byProject[projectId]).toMatchObject({
        selectedTabIdByWork: { "work-1": "knowledge" },
        tabs: [expect.objectContaining({ documentId: "knowledge" })],
      });
      expect(coordinator?.getProjectSnapshot(projectId)).toMatchObject({
        selection: { status: "rejected" },
        admitted: { scheme: "kb", path: "/knowledge.md", workId: "work-1" },
      });
      expect(readRecentRoutes(projectId)).toEqual([
        { documentId: "knowledge", scheme: "kb", path: "/knowledge.md" },
      ]);
      expect(search).toMatchObject({ screen: "context", scheme: "kb", path: "/knowledge.md" });
      const rawWorkingSet = workingSetStorage.getItem(WORKING_SET_STORAGE_KEY);
      expect(rawWorkingSet).not.toBeNull();
      expect(rawWorkingSet).not.toContain(wrongPath);
      expect(workingSetSync.localSnapshots.length).toBeGreaterThan(0);
      expect(workingSetSync.localSnapshots.every((sample) => sample.raw !== null)).toBe(true);
      expect(
        workingSetSync.localSnapshots.every(
          (snapshot) => !JSON.stringify(snapshot).includes(wrongPath),
        ),
      ).toBe(true);
      reconcileContextRoutes(projectId, {
        removedLocators: [],
        survivingOwnedLocators: [{ documentId: "knowledge", scheme: "kb", path: "/knowledge.md" }],
        promote: { documentId: "knowledge", scheme: "kb", path: "/knowledge.md" },
        clearAll: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 3_100));
      expect(emittedReports.length).toBeGreaterThan(0);
      expect(emittedReports.every((report) => !JSON.stringify(report).includes(wrongPath))).toBe(
        true,
      );
    });
  } finally {
    reportSpy?.mockRestore();
    configureWorkingSetSync(accountId, false);
  }
});
