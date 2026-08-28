import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import type { ReconcileContextRoutesInput } from "@/client/working-set";
import {
  DeviceWorkingSetStore,
  reconcileSnapshotContextRoutes,
  WORKING_SET_STORAGE_KEY,
} from "@/client/working-set/store";
import type { ProjectSearch } from "../routing/project-route";
import {
  ContextRemovalCoordinator,
  type ContextRemovalRoutePort,
} from "./context-removal-coordinator";
import type { AcknowledgedContextDeleteCommand } from "./context-removal-protocol";

const projectId = "project-1";

function tracked(documentId: string, path: string): ContextTab {
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
  let search = initialSearch;
  let routes: WorkingSetRoute[] = [];
  const route: ContextRemovalRoutePort = {
    readSearch: () => search,
    updateSearch: (_projectId, update) => {
      search = update(search);
    },
  };
  const workingSet = {
    readRecentRoutes: () => routes,
    reconcileContextRoutes: (_projectId: string, input: ReconcileContextRoutesInput) => {
      routes = reconcileSnapshotContextRoutes(
        { recentRoutes: routes, lastThreadId: null },
        input,
      ).recentRoutes;
      return routes;
    },
  };
  const coordinator = new ContextRemovalCoordinator("account-1", { workingSet, route });
  return {
    coordinator,
    search: () => search,
    routes: () => routes,
    setRoutes: (next: WorkingSetRoute[]) => {
      routes = next;
    },
  };
}

function admit(
  coordinator: ContextRemovalCoordinator,
  capture: ReturnType<ContextRemovalCoordinator["captureDeleteInitiation"]>,
  deletedDocumentIds: readonly string[],
): AcknowledgedContextDeleteCommand {
  const command: AcknowledgedContextDeleteCommand = {
    ...capture,
    cause: "acknowledged-delete",
    confirmed: { status: "deleted", deletedDocumentIds },
  };
  coordinator.acceptAcknowledgedDelete(command);
  return command;
}

describe("ContextRemovalCoordinator exact evidence protocol", () => {
  beforeEach(() => setDesk([], null));

  it("preserves a pending phone locator through an unrelated desk removal", () => {
    setDesk([tracked("desktop", "/desktop.md")], "desktop");
    const rig = scenario({ screen: "context", work: "work-1", scheme: "kb", path: "/phone.md" });
    rig.setRoutes([
      { scheme: "kb", path: "/phone.md" },
      { scheme: "manuscript", path: "/desktop.md" },
    ]);
    rig.coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/phone.md",
      workId: "work-1",
    });

    admit(
      rig.coordinator,
      rig.coordinator.captureDeleteInitiation(projectId, {
        kind: "file",
        locator: { scheme: "manuscript", path: "/desktop.md", workId: "work-1" },
        documentId: "desktop",
      }),
      ["desktop"],
    );

    expect(rig.routes()[0]).toEqual({ scheme: "kb", path: "/phone.md" });
    expect(rig.coordinator.getProjectSnapshot(projectId).rememberedRoute?.path).toBe("/phone.md");
    expect(rig.search().path).toBe("/phone.md");
  });

  it("admits an exact pending phone delete synchronously and settles it later", () => {
    const rig = scenario({ screen: "context", work: "work-1", scheme: "kb", path: "/phone.md" });
    rig.setRoutes([{ scheme: "kb", path: "/phone.md" }]);
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/phone.md",
      workId: "work-1",
    });
    const capture = rig.coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator: { scheme: "kb", path: "/phone.md", workId: "work-1" },
      documentId: "phone",
    });

    const command = admit(rig.coordinator, capture, ["phone"]);
    expect(rig.coordinator.acceptAcknowledgedDelete(command)).toEqual({
      status: "replayed",
      outcome: "obligated",
    });
    expect(rig.routes()).toEqual([{ scheme: "kb", path: "/phone.md" }]);

    rig.coordinator.confirmRouteUnbound(projectId, revision);
    expect(rig.routes()).toEqual([]);
    expect(rig.search()).toEqual({ screen: "context", work: "work-1" });
  });

  it("rejects conflicting command ID reuse without a second effect", () => {
    setDesk([tracked("a", "/a.md"), tracked("b", "/b.md")], "b");
    const rig = scenario();
    const capture = rig.coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator: { scheme: "manuscript", path: "/a.md", workId: null },
      documentId: "a",
    });
    const command = admit(rig.coordinator, capture, ["a"]);
    const conflict = {
      ...command,
      confirmed: { status: "deleted" as const, deletedDocumentIds: ["a", "b"] },
    };

    expect(rig.coordinator.acceptAcknowledgedDelete(conflict)).toEqual({
      status: "rejected",
      reason: "command_conflict",
    });
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toMatchObject([
      { documentId: "b" },
    ]);
  });

  it.each([
    ["bound-same", "phone", true],
    ["bound-other", "replacement", false],
    ["unbound", null, true],
  ])("reduces late same-revision admission after %s settlement", (_case, identity, removes) => {
    const rig = scenario({ screen: "context", work: "work-1", scheme: "kb", path: "/phone.md" });
    rig.setRoutes([{ scheme: "kb", path: "/phone.md" }]);
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/phone.md",
      workId: "work-1",
    });
    const capture = rig.coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator: { scheme: "kb", path: "/phone.md", workId: "work-1" },
      documentId: "phone",
    });
    if (identity) {
      rig.coordinator.bindRouteSelection(projectId, revision, {
        kind: "server",
        documentId: identity,
      });
    } else {
      rig.coordinator.confirmRouteUnbound(projectId, revision);
    }

    admit(rig.coordinator, capture, ["phone"]);

    expect(rig.routes().some((route) => route.path === "/phone.md")).toBe(!removes);
    expect(rig.search().path === "/phone.md").toBe(!removes);
  });

  it("never assigns an unrelated singleton receipt to a superseded locator", () => {
    const rig = scenario({ screen: "context", work: "work-1", scheme: "kb", path: "/phone.md" });
    rig.setRoutes([{ scheme: "kb", path: "/phone.md" }]);
    rig.coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/phone.md",
      workId: "work-1",
    });
    const unrelated = rig.coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator: { scheme: "kb", path: "/other.md", workId: "work-1" },
      documentId: "other",
    });
    rig.coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/new.md",
      workId: "work-1",
    });

    admit(rig.coordinator, unrelated, ["other"]);

    expect(rig.routes()).toEqual([
      { scheme: "kb", path: "/new.md" },
      { scheme: "kb", path: "/phone.md" },
    ]);
  });

  it.each([
    "writer-close",
    "work-prune",
    "draft-discard",
  ] as const)("settles the named %s command against its represented pending route", (cause) => {
    const tab = {
      ...tracked("a", "/a.md"),
      ...(cause === "work-prune" ? { scheme: "scratch" as const, workId: "work-1" } : {}),
      ...(cause === "draft-discard" ? { draftOnly: true, reviewWorkId: "work-1" } : {}),
    };
    setDesk([tab], "a");
    const scheme = cause === "work-prune" ? "scratch" : "manuscript";
    const rig = scenario({
      screen: "context",
      scheme,
      path: "/a.md",
      work: "work-1",
    });
    rig.setRoutes([
      scheme === "scratch"
        ? { scheme, path: "/a.md", workId: "work-1" }
        : { scheme, path: "/a.md" },
    ]);
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme,
      path: "/a.md",
      workId: "work-1",
    });

    if (cause === "writer-close") rig.coordinator.writerClose(projectId, "a");
    else if (cause === "work-prune") rig.coordinator.pruneWork(projectId, "work-2");
    else rig.coordinator.discardDraft(projectId, "work-1", "a");
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toEqual([]);
    expect(rig.routes()).not.toEqual([]);

    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "a",
    });
    expect(rig.routes()).toEqual([]);
  });

  it("advances selection revision for same-locator identity replacement", () => {
    const rig = scenario();
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/same.md",
      workId: null,
    });
    rig.coordinator.bindRouteSelection(projectId, revision, { kind: "server", documentId: "a" });
    rig.coordinator.bindRouteSelection(projectId, revision, { kind: "server", documentId: "b" });
    expect(rig.coordinator.getProjectSnapshot(projectId).selection).toMatchObject({
      status: "bound",
      revision: revision + 1,
      identity: { documentId: "b" },
    });
  });

  it("rejects stale activation after the selected document was removed", () => {
    setDesk([tracked("a", "/a.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/a.md" });
    rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-1",
    );
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "a",
    });
    const before = rig.coordinator.getProjectSnapshot(projectId);
    const capture = rig.coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator: { scheme: "manuscript", path: "/a.md", workId: "work-1" },
      documentId: "a",
    });
    admit(rig.coordinator, capture, ["a"]);

    expect(
      rig.coordinator.activate({
        projectId,
        selectionRevision: revision,
        transitionRevision: before.transitionRevision,
        locator: { scheme: "manuscript", path: "/a.md", workId: "work-1" },
        identity: { kind: "server", documentId: "a" },
      }),
    ).toBe(false);
    expect(rig.coordinator.getProjectSnapshot(projectId).rememberedRoute).toBeNull();
  });

  it("rejects a surviving route's stale transition ticket and accepts its fresh ticket", () => {
    setDesk([tracked("a", "/a.md"), tracked("b", "/b.md")], "b");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/b.md" });
    rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-1",
    );
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/b.md",
      workId: "work-1",
    });
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "b",
    });
    const staleTransition = rig.coordinator.getProjectSnapshot(projectId).transitionRevision;
    admit(
      rig.coordinator,
      rig.coordinator.captureDeleteInitiation(projectId, {
        kind: "file",
        locator: { scheme: "manuscript", path: "/a.md", workId: "work-1" },
        documentId: "a",
      }),
      ["a"],
    );
    const freshTransition = rig.coordinator.getProjectSnapshot(projectId).transitionRevision;
    const activation = {
      projectId,
      selectionRevision: revision,
      locator: { scheme: "manuscript" as const, path: "/b.md", workId: "work-1" },
      identity: { kind: "server" as const, documentId: "b" },
    };

    expect(rig.coordinator.activate({ ...activation, transitionRevision: staleTransition })).toBe(
      false,
    );
    expect(rig.coordinator.activate({ ...activation, transitionRevision: freshTransition })).toBe(
      true,
    );
  });

  it("persists exact phone cleanup so reload cannot resurrect it", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const store = new DeviceWorkingSetStore(storage);
    store.setUser("account-1");
    store.adopt(projectId, {
      recentRoutes: [{ scheme: "kb", path: "/phone.md" }],
      lastThreadId: null,
    });
    let search: ProjectSearch = {
      screen: "context",
      work: "work-1",
      scheme: "kb",
      path: "/phone.md",
    };
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
      route: {
        readSearch: () => search,
        updateSearch: (_id, update) => {
          search = update(search);
        },
      },
    });
    const revision = coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/phone.md",
      workId: "work-1",
    });
    coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "phone",
    });
    const capture = coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator: { scheme: "kb", path: "/phone.md", workId: "work-1" },
      documentId: "phone",
    });
    admit(coordinator, capture, ["phone"]);

    expect(values.get(WORKING_SET_STORAGE_KEY)).not.toContain("/phone.md");
    const reconstructed = new DeviceWorkingSetStore(storage);
    reconstructed.setUser("account-1");
    expect(reconstructed.read(projectId)?.snapshot.recentRoutes).toEqual([]);
  });
});
