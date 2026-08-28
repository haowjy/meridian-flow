/** Work-transition composition coverage for the Context removal coordinator. */

import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import type { ReconcileContextRoutesInput } from "@/client/working-set";
import { DeviceWorkingSetStore, reconcileSnapshotContextRoutes } from "@/client/working-set/store";
import type { ProjectSearch } from "../routing/project-route";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";

const projectId = "project-1";

function tracked(documentId: string, path: string): Extract<ContextTab, { kind: "tracked" }> {
  return {
    kind: "tracked",
    documentId,
    scheme: "manuscript",
    path,
    name: path.slice(1),
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

function setDesk(tabs: ContextTab[], activeTabId: string | null) {
  useContextTabsStore.setState({
    byProject: { [projectId]: { tabs, activeTabId } },
    _deskHydrated: false,
  });
}

function scenario(initialSearch: ProjectSearch = { screen: "context" }) {
  const search = initialSearch;
  let routes: WorkingSetRoute[] = [];
  const coordinator = new ContextRemovalCoordinator("account-1", {
    workingSet: {
      readRecentRoutes: () => routes,
      reconcileContextRoutes: (_projectId: string, input: ReconcileContextRoutesInput) => {
        routes = reconcileSnapshotContextRoutes(
          { recentRoutes: routes, lastThreadId: null },
          input,
        ).recentRoutes;
        return routes;
      },
    },
  });
  return {
    coordinator,
    search: () => search,
    routes: () => routes,
    setRoutes: (next: WorkingSetRoute[]) => {
      routes = next;
    },
  };
}

function acknowledgeDeleted(
  coordinator: ContextRemovalCoordinator,
  documentId: string,
  workId: string,
) {
  const locator = { scheme: "manuscript" as const, path: "/deleted.md", workId };
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

describe("ContextRemovalCoordinator Work transitions", () => {
  beforeEach(() => setDesk([], null));

  it("initial registration establishes Work ownership and prunes restored old-Work state", () => {
    setDesk([{ ...tracked("old", "/old.md"), scheme: "scratch", workId: "work-old" }], "old");
    const rig = scenario();
    rig.setRoutes([
      { scheme: "scratch", path: "/old.md", workId: "work-old" },
      { scheme: "scratch", path: "/new.md", workId: "work-new" },
    ]);

    rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-new",
    );

    expect(useContextTabsStore.getState().byProject[projectId]).toEqual({
      tabs: [],
      activeTabId: null,
    });
    expect(rig.routes()).toEqual([{ scheme: "scratch", path: "/new.md", workId: "work-new" }]);
    expect(rig.coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "none" },
      admitted: { path: "/new.md", workId: "work-new" },
      live: true,
    });
  });

  it.each([
    "empty",
    "pending",
  ] as const)("keeps the Work-A %s untitled across A to B to A without persisting scratch root", (state) => {
    const storageValues = new Map<string, string>();
    const storageWrites: string[] = [];
    const storage = {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageValues.set(key, value);
        storageWrites.push(value);
      },
      removeItem: (key: string) => storageValues.delete(key),
    };
    const workingSet = new DeviceWorkingSetStore(storage);
    workingSet.setUser("account-1");
    workingSet.adopt(projectId, {
      recentRoutes: [{ scheme: "kb", path: "/knowledge.md" }],
      lastThreadId: null,
    });
    storageWrites.length = 0;
    const reports: WorkingSetRoute[][] = [];
    const untitled = {
      kind: "new",
      documentId: "untitled-a",
      name: "Untitled",
      workId: "work-a",
    } as ContextTab;
    const oldWorkTab = {
      ...tracked("old-work-document", "/old-work.md"),
      scheme: "scratch" as const,
      workId: "work-a",
    };
    const knowledge = { ...tracked("knowledge", "/knowledge.md"), scheme: "kb" as const };
    setDesk([untitled, oldWorkTab, knowledge], untitled.documentId);
    const pendingOwner =
      state === "pending"
        ? {
            documentId: untitled.documentId,
            projectId,
            home: { scheme: "scratch", workId: "work-a" },
          }
        : null;
    let search: ProjectSearch = {
      screen: "context",
      work: "work-a",
      scheme: "scratch",
      path: "",
    };
    const coordinator = new ContextRemovalCoordinator("account-1", {
      workingSet: {
        readRecentRoutes: () => workingSet.read(projectId)?.snapshot.recentRoutes ?? [],
        reconcileContextRoutes: (_id, input) => {
          workingSet.report(projectId, null, (snapshot) =>
            reconcileSnapshotContextRoutes(snapshot, input),
          );
          const routes = workingSet.read(projectId)?.snapshot.recentRoutes ?? [];
          reports.push(routes);
          return routes;
        },
      },
    });
    coordinator.registerRoutePort(
      projectId,
      {
        readSearch: () => search,
        updateSearch: (_id, update) => {
          search = update(search);
        },
      },
      "work-a",
    );

    expect(coordinator.getProjectSnapshot(projectId).admitted).toEqual({
      scheme: "scratch",
      path: "",
      workId: "work-a",
    });
    expect(reports).toEqual([[{ scheme: "kb", path: "/knowledge.md" }]]);
    const initialRevision = coordinator.beginRouteSelection(projectId, {
      scheme: "scratch",
      path: "",
      workId: "work-a",
    });
    coordinator.bindRouteSelection(projectId, initialRevision, {
      kind: "local",
      documentId: untitled.documentId,
    });
    const initialSnapshot = coordinator.getProjectSnapshot(projectId);
    expect(
      coordinator.activate({
        projectId,
        selectionRevision: initialRevision,
        transitionRevision: initialSnapshot.transitionRevision,
        locator: { scheme: "scratch", path: "", workId: "work-a" },
        identity: { kind: "local", documentId: untitled.documentId },
        owner: { kind: "desk", documentId: untitled.documentId },
      }),
    ).toBe(true);

    search = { screen: "context", work: "work-b", scheme: "scratch", path: "" };
    coordinator.changeWorkSelection(projectId, "work-b", null);

    expect(coordinator.getProjectSnapshot(projectId).admitted).toEqual({
      scheme: "kb",
      path: "/knowledge.md",
      workId: "work-b",
    });
    expect(useContextTabsStore.getState().byProject[projectId]).toEqual({
      tabs: [untitled, knowledge],
      activeTabId: knowledge.documentId,
    });
    expect(pendingOwner?.home.workId ?? "work-a").toBe("work-a");

    search = { screen: "context", work: "work-a", scheme: "scratch", path: "" };
    coordinator.changeWorkSelection(projectId, "work-a", null);
    useContextTabsStore.getState().selectTab(projectId, untitled.documentId);
    const revision = coordinator.beginRouteSelection(projectId, {
      scheme: "scratch",
      path: "",
      workId: "work-a",
    });
    expect(
      coordinator.bindRouteSelection(projectId, revision, {
        kind: "local",
        documentId: untitled.documentId,
      }),
    ).toBe(true);
    const snapshot = coordinator.getProjectSnapshot(projectId);
    expect(
      coordinator.activate({
        projectId,
        selectionRevision: revision,
        transitionRevision: snapshot.transitionRevision,
        locator: { scheme: "scratch", path: "", workId: "work-a" },
        identity: { kind: "local", documentId: untitled.documentId },
        owner: { kind: "desk", documentId: untitled.documentId },
      }),
    ).toBe(true);
    expect(coordinator.getProjectSnapshot(projectId).admitted).toEqual({
      scheme: "scratch",
      path: "",
      workId: "work-a",
    });

    const everyRoute = [
      ...reports,
      ...storageWrites
        .map((raw) => JSON.parse(raw))
        .flatMap(
          (record: {
            projects: Record<string, { snapshot: { recentRoutes: WorkingSetRoute[] } }>;
          }) => [record.projects[projectId]?.snapshot.recentRoutes ?? []],
        ),
    ].flat();
    expect(everyRoute).not.toContainEqual({
      scheme: "scratch",
      path: "",
      workId: "work-a",
    });
    expect(everyRoute).not.toContainEqual({
      scheme: "scratch",
      path: "",
      workId: "work-b",
    });
    const reconstructed = new DeviceWorkingSetStore(storage);
    reconstructed.setUser("account-1");
    expect(reconstructed.read(projectId)?.snapshot.recentRoutes).toEqual([
      { scheme: "kb", path: "/knowledge.md" },
    ]);
  });

  it("restores the new Work recent route when Work changes off Context", () => {
    const rig = scenario({ screen: "home", work: "work-old" });
    rig.setRoutes([
      { scheme: "scratch", path: "/old.md", workId: "work-old" },
      { scheme: "manuscript", path: "/new.md" },
    ]);
    rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-old",
    );
    rig.coordinator.clearRouteSelection(projectId);

    const revision = rig.coordinator.changeWorkSelection(projectId, "work-new", null);

    expect(revision).toBeNull();
    expect(rig.routes()).toEqual([{ scheme: "manuscript", path: "/new.md" }]);
    expect(rig.coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "none" },
      admitted: { path: "/new.md", workId: "work-new" },
    });
  });

  it("keeps project-scoped admitted fallback independent of the same route candidate", () => {
    setDesk([tracked("knowledge", "/knowledge.md")], "knowledge");
    const rig = scenario({
      screen: "context",
      work: "work-2",
      scheme: "manuscript",
      path: "/knowledge.md",
    });
    rig.setRoutes([{ scheme: "manuscript", path: "/knowledge.md" }]);
    rig.coordinator.changeWorkSelection(projectId, "work-1", null);

    const revision = rig.coordinator.changeWorkSelection(projectId, "work-2", {
      scheme: "manuscript",
      path: "/knowledge.md",
      workId: "work-2",
    });

    expect(revision).toBeTypeOf("number");
    expect(rig.coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "candidate", locator: { path: "/knowledge.md", workId: "work-2" } },
      admitted: { path: "/knowledge.md", workId: "work-2" },
    });
    expect(rig.routes()).toEqual([{ scheme: "manuscript", path: "/knowledge.md" }]);
  });

  it("withholds a guarded deleted route from memory and durable reconstruction", () => {
    setDesk([tracked("deleted", "/deleted.md")], "deleted");
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const store = new DeviceWorkingSetStore(storage);
    store.setUser("account-1");
    store.adopt(projectId, {
      recentRoutes: [{ scheme: "manuscript", path: "/deleted.md" }],
      lastThreadId: null,
    });
    const coordinator = new ContextRemovalCoordinator("account-1", {
      workingSet: {
        readRecentRoutes: () => store.read(projectId)?.snapshot.recentRoutes ?? [],
        reconcileContextRoutes: (_id, input) => {
          const snapshot = reconcileSnapshotContextRoutes(
            store.read(projectId)?.snapshot ?? { recentRoutes: [], lastThreadId: null },
            input,
          );
          store.adopt(projectId, snapshot);
          return snapshot.recentRoutes;
        },
      },
    });
    coordinator.registerRoutePort(
      projectId,
      { readSearch: () => ({ screen: "home" }), updateSearch: () => undefined },
      "work-old",
    );
    const revision = coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/deleted.md",
      workId: "work-old",
    });
    coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "deleted",
    });
    acknowledgeDeleted(coordinator, "deleted", "work-old");
    coordinator.changeWorkSelection(projectId, "work-new", null);

    const guardedRevision = coordinator.changeWorkSelection(projectId, "work-old", {
      scheme: "manuscript",
      path: "/deleted.md",
      workId: "work-old",
    });

    expect(coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "candidate", reentryGuard: expect.any(Object) },
      admitted: null,
    });
    expect(store.read(projectId)?.snapshot.recentRoutes).toEqual([]);
    const reconstructed = new DeviceWorkingSetStore(storage);
    reconstructed.setUser("account-1");
    expect(reconstructed.read(projectId)?.snapshot.recentRoutes).toEqual([]);

    coordinator.rejectRouteCandidate(projectId, guardedRevision as number);
    expect(coordinator.getProjectSnapshot(projectId).admitted).toBeNull();
    expect(store.read(projectId)?.snapshot.recentRoutes).toEqual([]);
  });

  it("promotes a replacement identity after guarded Work re-entry binds", () => {
    setDesk([tracked("deleted", "/deleted.md")], "deleted");
    const rig = scenario();
    rig.setRoutes([{ scheme: "manuscript", path: "/deleted.md" }]);
    rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-old",
    );
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/deleted.md",
      workId: "work-old",
    });
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "deleted",
    });
    acknowledgeDeleted(rig.coordinator, "deleted", "work-old");
    rig.coordinator.changeWorkSelection(projectId, "work-new", null);
    const guardedRevision = rig.coordinator.changeWorkSelection(projectId, "work-old", {
      scheme: "manuscript",
      path: "/deleted.md",
      workId: "work-old",
    });
    setDesk([tracked("replacement", "/deleted.md")], "replacement");

    rig.coordinator.bindRouteSelection(projectId, guardedRevision as number, {
      kind: "server",
      documentId: "replacement",
    });
    const snapshot = rig.coordinator.getProjectSnapshot(projectId);
    rig.coordinator.activate({
      projectId,
      selectionRevision: snapshot.selection.revision,
      transitionRevision: snapshot.transitionRevision,
      locator: { scheme: "manuscript", path: "/deleted.md", workId: "work-old" },
      identity: { kind: "server", documentId: "replacement" },
      owner: { kind: "desk", documentId: "replacement" },
    });

    expect(rig.routes()).toEqual([{ scheme: "manuscript", path: "/deleted.md" }]);
    expect(rig.coordinator.getProjectSnapshot(projectId).admitted).toEqual({
      scheme: "manuscript",
      path: "/deleted.md",
      workId: "work-old",
    });
  });
});
