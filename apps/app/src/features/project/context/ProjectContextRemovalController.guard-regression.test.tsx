/** Production-controller guard regression over the browser working-set adapter. */

import { act, useLayoutEffect, useState } from "react";
import { expect, it } from "vitest";
import { useContextTabsStore } from "@/client/stores";
import {
  configureWorkingSetSync,
  readRecentRoutes,
  reconcileContextRoutes,
} from "@/client/working-set/driver";
import { DeviceWorkingSetStore, WORKING_SET_STORAGE_KEY } from "@/client/working-set/store";
import { withReactRoot } from "@/test-support/react-dom-harness";
import type { ProjectSearch } from "../routing/project-route";
import {
  ContextRemovalAccountProvider,
  useContextRemovalCoordinator,
} from "./ContextRemovalAccountProvider";
import type { ContextRemovalCoordinator } from "./context-removal-coordinator";
import { ProjectContextRemovalController } from "./ProjectContextRemovalController";
import { useContextRemovalProject } from "./use-context-removal-project";

it("keeps a terminally guarded production entry absent until replacement identity binds", async () => {
  const projectId = "guarded-entry-project";
  const accountId = "guarded-entry-account";
  const workId = "work-1";
  const locatorA = { scheme: "manuscript" as const, path: "/a.md", workId };
  const locatorC = { scheme: "manuscript" as const, path: "/c.md", workId };
  useContextTabsStore.setState({
    byProject: {
      [projectId]: {
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
          {
            kind: "tracked",
            documentId: "c",
            scheme: "manuscript",
            path: "/c.md",
            name: "c.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
          },
        ],
        activeTabId: "a",
      },
    },
    _deskHydrated: true,
  });

  let coordinator: ContextRemovalCoordinator | null = null;
  let setEntry: ((entry: { screen: "home" | "context"; path: string | null }) => void) | null =
    null;
  let search: ProjectSearch = { screen: "home" };
  const productionRoute = {
    readSearch: () => search,
    updateSearch: (_projectId: string, update: (current: ProjectSearch) => ProjectSearch) => {
      search = update(search);
    },
  };
  function SeedWorkingSet() {
    useLayoutEffect(() => {
      window.localStorage.removeItem(WORKING_SET_STORAGE_KEY);
      configureWorkingSetSync(accountId, false);
      reconcileContextRoutes(projectId, {
        removedLocators: [],
        survivingOwnedLocators: [],
        promote: { scheme: "manuscript", path: "/c.md" },
        clearAll: false,
      });
      reconcileContextRoutes(projectId, {
        removedLocators: [],
        survivingOwnedLocators: [],
        promote: { scheme: "manuscript", path: "/a.md" },
        clearAll: false,
      });
    }, []);
    return null;
  }
  function Capture() {
    coordinator = useContextRemovalCoordinator();
    return null;
  }
  function Harness() {
    const [entry, updateEntry] = useState<{
      screen: "home" | "context";
      path: string | null;
    }>({ screen: "home", path: null });
    setEntry = updateEntry;
    return (
      <ContextRemovalAccountProvider accountId={accountId}>
        <SeedWorkingSet />
        <Capture />
        <ProjectContextRemovalController
          projectId={projectId}
          activeScreen={entry.screen}
          activeContextScheme={entry.path ? "manuscript" : null}
          activeContextPath={entry.path}
          editorWorkId={workId}
          route={productionRoute}
        />
      </ContextRemovalAccountProvider>
    );
  }

  function admitExact(locator: typeof locatorA, documentId: string) {
    if (!coordinator) throw new Error("expected coordinator");
    const capture = coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator,
      documentId,
    });
    coordinator.acceptAcknowledgedDelete({
      ...capture,
      cause: "acknowledged-delete",
      confirmed: { status: "deleted", deletedDocumentIds: [documentId] },
    });
  }

  function expectAAbsent() {
    if (!coordinator) throw new Error("expected coordinator");
    expect(coordinator.getProjectSnapshot(projectId).admitted?.path).not.toBe("/a.md");
    expect(readRecentRoutes(projectId)).not.toContainEqual(
      expect.objectContaining({ path: "/a.md" }),
    );
    const raw = window.localStorage.getItem(WORKING_SET_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("/a.md");
    const reconstructed = new DeviceWorkingSetStore(window.localStorage);
    reconstructed.setUser(accountId);
    expect(reconstructed.read(projectId)?.snapshot.recentRoutes ?? []).not.toContainEqual(
      expect.objectContaining({ path: "/a.md" }),
    );
  }

  await withReactRoot(<Harness />, async () => {
    if (!coordinator) throw new Error("expected coordinator");
    expect(readRecentRoutes(projectId)).toEqual([
      { scheme: "manuscript", path: "/a.md" },
      { scheme: "manuscript", path: "/c.md" },
    ]);
    expect(window.localStorage.getItem(WORKING_SET_STORAGE_KEY)).toContain("/a.md");
    let revision = coordinator.beginRouteSelection(projectId, locatorA);
    coordinator.bindRouteSelection(projectId, revision, { kind: "server", documentId: "a" });
    admitExact(locatorA, "a");

    revision = coordinator.beginRouteSelection(projectId, locatorC);
    admitExact(locatorC, "c");
    expect(coordinator.getProjectSnapshot(projectId).selection).toMatchObject({
      status: "candidate",
      revision,
      locator: locatorC,
      obligations: [expect.any(Object)],
    });

    search = { screen: "context", work: workId, scheme: "manuscript", path: "/a.md" };
    await act(async () => setEntry?.({ screen: "context", path: "/a.md" }));

    const guarded = coordinator.getProjectSnapshot(projectId);
    expect(guarded).toMatchObject({
      selection: { status: "candidate", locator: locatorA },
      admitted: null,
      removalFence: { removedDocumentIds: ["c"] },
    });
    expect(search).toEqual({
      screen: "context",
      work: workId,
      scheme: "manuscript",
      path: "/a.md",
    });
    expectAAbsent();

    const guardedRevision = guarded.selection.revision;
    coordinator.rejectRouteCandidate(projectId, guardedRevision);
    expectAAbsent();

    const replacementRevision = coordinator.beginRouteSelection(projectId, locatorA);
    useContextTabsStore.setState((state) => ({
      ...state,
      byProject: {
        ...state.byProject,
        [projectId]: {
          tabs: [
            {
              kind: "tracked",
              documentId: "replacement-a",
              scheme: "manuscript",
              path: "/a.md",
              name: "a.md",
              editable: true,
              filetype: "markdown",
              schemaType: "document",
            },
          ],
          activeTabId: "replacement-a",
        },
      },
    }));
    coordinator.bindRouteSelection(projectId, replacementRevision, {
      kind: "server",
      documentId: "replacement-a",
    });
    const replacementSnapshot = coordinator.getProjectSnapshot(projectId);
    coordinator.activate({
      projectId,
      selectionRevision: replacementSnapshot.selection.revision,
      transitionRevision: replacementSnapshot.transitionRevision,
      locator: locatorA,
      identity: { kind: "server", documentId: "replacement-a" },
      owner: { kind: "desk", documentId: "replacement-a" },
    });
    expect(coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: {
        status: "bound",
        locator: locatorA,
        identity: { documentId: "replacement-a" },
      },
      admitted: locatorA,
    });
    expect(readRecentRoutes(projectId)).toContainEqual({
      scheme: "manuscript",
      path: "/a.md",
    });
    expect(window.localStorage.getItem(WORKING_SET_STORAGE_KEY)).toContain("/a.md");
    const reconstructed = new DeviceWorkingSetStore(window.localStorage);
    reconstructed.setUser(accountId);
    expect(reconstructed.read(projectId)?.snapshot.recentRoutes).toContainEqual({
      scheme: "manuscript",
      path: "/a.md",
    });
  });
});

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
        activeTabId: "work-2-document",
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
  function Capture() {
    coordinator = useContextRemovalCoordinator();
    return null;
  }
  function Harness() {
    const [workId, setWorkId] = useState("work-2");
    switchWork = () => {
      search = { ...search, work: "work-1" };
      setWorkId("work-1");
    };
    return (
      <ContextRemovalAccountProvider accountId={accountId}>
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
      </ContextRemovalAccountProvider>
    );
  }

  await withReactRoot(<Harness />, async () => {
    window.localStorage.removeItem(WORKING_SET_STORAGE_KEY);
    configureWorkingSetSync(accountId, false);
    reconcileContextRoutes(projectId, {
      removedLocators: [],
      survivingOwnedLocators: [
        { scheme: "kb", path: "/knowledge.md" },
        { scheme: "scratch", path: wrongPath, workId: "work-2" },
      ],
      promote: { scheme: "scratch", path: wrongPath, workId: "work-2" },
      clearAll: false,
    });
    reconcileContextRoutes(projectId, {
      removedLocators: [],
      survivingOwnedLocators: [{ scheme: "kb", path: "/knowledge.md" }],
      promote: { scheme: "kb", path: "/knowledge.md" },
      clearAll: false,
    });
    await act(async () => switchWork?.());

    expect(useContextTabsStore.getState().byProject[projectId]).toMatchObject({
      activeTabId: "knowledge",
      tabs: [expect.objectContaining({ documentId: "knowledge" })],
    });
    expect(coordinator?.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "rejected" },
      admitted: { scheme: "kb", path: "/knowledge.md", workId: "work-1" },
    });
    expect(readRecentRoutes(projectId)).toEqual([{ scheme: "kb", path: "/knowledge.md" }]);
    expect(search).toMatchObject({ screen: "context", scheme: "kb", path: "/knowledge.md" });
    expect(window.localStorage.getItem(WORKING_SET_STORAGE_KEY) ?? "").not.toContain(wrongPath);
  });
});
