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
      selection: { status: "pending", locator: { path: "/new.md", workId: "work-new" } },
      rememberedRoute: { path: "/new.md", workId: "work-new" },
      live: true,
    });
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

    expect(revision).toBeTypeOf("number");
    expect(rig.routes()).toEqual([{ scheme: "manuscript", path: "/new.md" }]);
    expect(rig.coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "pending", locator: { path: "/new.md", workId: "work-new" } },
      rememberedRoute: { path: "/new.md", workId: "work-new" },
    });
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
      selection: { status: "pending", reentryGuard: expect.any(Object) },
      rememberedRoute: null,
    });
    expect(store.read(projectId)?.snapshot.recentRoutes).toEqual([]);
    const reconstructed = new DeviceWorkingSetStore(storage);
    reconstructed.setUser("account-1");
    expect(reconstructed.read(projectId)?.snapshot.recentRoutes).toEqual([]);

    coordinator.confirmRouteUnbound(projectId, guardedRevision as number);
    expect(coordinator.getProjectSnapshot(projectId).rememberedRoute).toBeNull();
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

    expect(rig.routes()).toEqual([{ scheme: "manuscript", path: "/deleted.md" }]);
    expect(rig.coordinator.getProjectSnapshot(projectId).rememberedRoute).toEqual({
      scheme: "manuscript",
      path: "/deleted.md",
      workId: "work-old",
    });
  });
});
