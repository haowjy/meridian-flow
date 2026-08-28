import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { type ContextTab, useContextTabsStore } from "@/client/stores";
import type { ReconcileContextRoutesInput } from "@/client/working-set";
import { WorkingSetSyncDriver } from "@/client/working-set/driver";
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

const projectId = "project-1";

function tracked(
  documentId: string,
  path: string,
  extras: Partial<Extract<ContextTab, { kind: "tracked" }>> = {},
): ContextTab {
  return {
    kind: "tracked",
    documentId,
    scheme: "manuscript",
    path,
    name: path.slice(1),
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    ...extras,
  };
}

function setDesk(project: string, tabs: ContextTab[], activeTabId: string | null) {
  useContextTabsStore.setState((state) => ({
    byProject: { ...state.byProject, [project]: { tabs, activeTabId } },
    _deskHydrated: false,
  }));
}

function scenario(initialSearch: ProjectSearch = { screen: "context" }) {
  let search = initialSearch;
  let routes: WorkingSetRoute[] = [];
  let delayedUpdate: ((latest: ProjectSearch) => ProjectSearch) | null = null;
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
  const coordinator = new ContextRemovalCoordinator({ workingSet, route });
  return {
    coordinator,
    route,
    search: () => search,
    setSearch: (next: ProjectSearch) => {
      search = next;
    },
    routes: () => routes,
    setRoutes: (next: WorkingSetRoute[]) => {
      routes = next;
    },
    delayRepairs: () => {
      route.updateSearch = (_projectId, update) => {
        delayedUpdate = update;
      };
    },
    flushRepair: () => {
      if (delayedUpdate) search = delayedUpdate(search);
    },
  };
}

function bind(
  coordinator: ContextRemovalCoordinator,
  path: string,
  documentId: string,
  options: {
    scheme?: "manuscript" | "kb" | "scratch";
    workId?: string | null;
    kind?: "server" | "local";
  } = {},
) {
  const revision = coordinator.beginRouteSelection(projectId, {
    scheme: options.scheme ?? "manuscript",
    path,
    workId: options.workId ?? null,
  });
  coordinator.bindRouteSelection(projectId, revision, {
    kind: options.kind ?? "server",
    documentId,
  });
  return revision;
}

describe("ContextRemovalCoordinator production-state convergence", () => {
  beforeEach(() => {
    useContextTabsStore.setState({ byProject: {}, _deskHydrated: false });
  });

  it("keeps the routed document and screen for an inactive acknowledged deletion", async () => {
    setDesk(projectId, [tracked("a", "/a.md"), tracked("b", "/b.md")], "b");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/b.md" });
    bind(rig.coordinator, "/b.md", "b");

    expect((await rig.coordinator.acknowledgedDelete(projectId, ["a"])).kind).toBe(
      "inactive-removal",
    );
    expect(useContextTabsStore.getState().byProject[projectId]).toMatchObject({
      tabs: [{ documentId: "b" }],
      activeTabId: "b",
    });
    expect(rig.search()).toMatchObject({ screen: "context", path: "/b.md" });
  });

  it("uses the routed tab as fallback anchor and preserves Editor Work for project schemes", async () => {
    setDesk(projectId, [tracked("a", "/a.md"), tracked("b", "/b.md"), tracked("c", "/c.md")], "a");
    const rig = scenario({
      screen: "context",
      work: "work-1",
      scheme: "manuscript",
      path: "/b.md",
    });
    bind(rig.coordinator, "/b.md", "b", { workId: "work-1" });

    expect(await rig.coordinator.acknowledgedDelete(projectId, ["b"])).toMatchObject({
      kind: "active-fallback",
      fallback: { documentId: "c" },
    });
    expect(rig.search()).toMatchObject({ work: "work-1", path: "/c.md" });
    expect(rig.coordinator.getProjectSnapshot(projectId).rememberedRoute).toEqual({
      scheme: "manuscript",
      path: "/c.md",
      workId: "work-1",
    });
  });

  it("uses the surviving tab's owning Work for Work-scoped fallback", async () => {
    setDesk(
      projectId,
      [
        tracked("a", "/a.md"),
        tracked("scratch", "/note.md", { scheme: "scratch", workId: "work-2" }),
      ],
      "a",
    );
    const rig = scenario({
      screen: "context",
      work: "work-1",
      scheme: "manuscript",
      path: "/a.md",
    });
    bind(rig.coordinator, "/a.md", "a", { workId: "work-1" });

    await rig.coordinator.acknowledgedDelete(projectId, ["a"]);
    expect(rig.search()).toMatchObject({ work: "work-2", scheme: "scratch", path: "/note.md" });
  });

  it("removes a phone-only locator from continuity so reload cannot resurrect it", async () => {
    setDesk(projectId, [], null);
    const rig = scenario({ screen: "context", work: "work-1", scheme: "kb", path: "/phone.md" });
    rig.setRoutes([{ scheme: "kb", path: "/phone.md" }]);
    bind(rig.coordinator, "/phone.md", "phone", { scheme: "kb", workId: "work-1" });

    expect(await rig.coordinator.acknowledgedDelete(projectId, ["phone"])).toMatchObject({
      kind: "route-only-removal",
    });
    expect(rig.search()).toEqual({ screen: "context", work: "work-1" });
    expect(rig.routes()).toEqual([]);
  });

  it("persists route-only cleanup through the production working-set driver and reconstruction", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const store = new DeviceWorkingSetStore(storage);
    const driver = new WorkingSetSyncDriver(store, async () => ({ revision: 1 }));
    driver.configure("account-1", false);
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
    const coordinator = new ContextRemovalCoordinator({
      workingSet: driver,
      route: {
        readSearch: () => search,
        updateSearch: (_id, update) => {
          search = update(search);
        },
      },
    });
    bind(coordinator, "/phone.md", "phone", { scheme: "kb", workId: "work-1" });

    await coordinator.acknowledgedDelete(projectId, ["phone"]);
    expect(values.get(WORKING_SET_STORAGE_KEY)).not.toContain("/phone.md");

    const reconstructed = new DeviceWorkingSetStore(storage);
    reconstructed.setUser("account-1");
    expect(reconstructed.read(projectId)?.snapshot.recentRoutes).toEqual([]);
  });

  it("retains a phone-only delete obligation until its exact pending revision binds", async () => {
    setDesk(projectId, [], null);
    const rig = scenario({ screen: "context", work: "work-1", scheme: "kb", path: "/phone.md" });
    rig.setRoutes([{ scheme: "kb", path: "/phone.md" }]);
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/phone.md",
      workId: "work-1",
    });

    const removal = rig.coordinator.acknowledgedDelete(projectId, ["phone"]);
    expect(rig.coordinator.getProjectSnapshot(projectId).autoOpenBlock).toMatchObject({
      selectionRevision: revision,
      documentIds: ["phone"],
    });
    expect(rig.routes()).toEqual([{ scheme: "kb", path: "/phone.md" }]);

    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "phone",
    });
    expect(await removal).toMatchObject({ kind: "route-only-removal" });
    expect(rig.search()).toEqual({ screen: "context", work: "work-1" });
    expect(rig.routes()).toEqual([]);
  });

  it("keeps a surviving phone route as continuity owner when an unrelated desk tab is removed", async () => {
    setDesk(projectId, [tracked("desktop", "/desktop.md")], "desktop");
    const rig = scenario({ screen: "context", work: "work-1", scheme: "kb", path: "/phone.md" });
    rig.setRoutes([
      { scheme: "manuscript", path: "/desktop.md" },
      { scheme: "kb", path: "/phone.md" },
    ]);
    bind(rig.coordinator, "/phone.md", "phone", { scheme: "kb", workId: "work-1" });

    expect((await rig.coordinator.acknowledgedDelete(projectId, ["desktop"])).kind).toBe(
      "empty-desk",
    );
    expect(rig.routes()).toEqual([{ scheme: "kb", path: "/phone.md" }]);
    expect(rig.coordinator.getProjectSnapshot(projectId).rememberedRoute).toEqual({
      scheme: "kb",
      path: "/phone.md",
      workId: "work-1",
    });
    expect(rig.search()).toMatchObject({ screen: "context", path: "/phone.md" });
  });

  it("promotes a surviving phone route over an unrelated remaining desk tab", async () => {
    setDesk(
      projectId,
      [tracked("removed", "/removed.md"), tracked("desktop", "/desktop.md")],
      "desktop",
    );
    const rig = scenario({ screen: "context", work: "work-1", scheme: "kb", path: "/phone.md" });
    rig.setRoutes([
      { scheme: "manuscript", path: "/removed.md" },
      { scheme: "manuscript", path: "/desktop.md" },
      { scheme: "kb", path: "/phone.md" },
    ]);
    bind(rig.coordinator, "/phone.md", "phone", { scheme: "kb", workId: "work-1" });

    await rig.coordinator.acknowledgedDelete(projectId, ["removed"]);
    expect(rig.routes()[0]).toEqual({ scheme: "kb", path: "/phone.md" });
    expect(rig.coordinator.getProjectSnapshot(projectId).rememberedRoute?.path).toBe("/phone.md");
  });

  it("preserves a same-locator replacement when the old identity receipt arrives", async () => {
    setDesk(projectId, [tracked("old", "/same.md")], "old");
    useContextTabsStore.getState().openTab(projectId, tracked("replacement", "/same.md"));
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/same.md" });
    rig.setRoutes([{ scheme: "manuscript", path: "/same.md" }]);
    bind(rig.coordinator, "/same.md", "replacement");

    expect((await rig.coordinator.acknowledgedDelete(projectId, ["old"])).kind).toBe("noop");
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toMatchObject([
      { documentId: "replacement" },
    ]);
    expect(rig.routes()).toEqual([{ scheme: "manuscript", path: "/same.md" }]);
  });

  it("blocks auto-open synchronously and clears the active route when the desk empties", async () => {
    setDesk(projectId, [tracked("a", "/a.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/a.md" });
    const revision = bind(rig.coordinator, "/a.md", "a");

    const removal = rig.coordinator.writerClose(projectId, "a");
    expect(rig.coordinator.getProjectSnapshot(projectId).autoOpenBlock).toMatchObject({
      selectionRevision: revision,
      locator: { path: "/a.md" },
      documentIds: ["a"],
    });
    expect((await removal).kind).toBe("empty-desk");
    expect(rig.search()).toEqual({ screen: "context" });
  });

  it.each([
    [
      "writer close",
      (coordinator: ContextRemovalCoordinator) => coordinator.writerClose(projectId, "a"),
    ],
    [
      "Work prune",
      (coordinator: ContextRemovalCoordinator) => coordinator.pruneWork(projectId, "work-2"),
    ],
    [
      "draft discard",
      (coordinator: ContextRemovalCoordinator) =>
        coordinator.discardDraft(projectId, "work-1", "a"),
    ],
  ])("retains pending route responsibility for %s", async (_label, remove) => {
    const extras =
      _label === "Work prune"
        ? { scheme: "scratch" as const, workId: "work-1" }
        : _label === "draft discard"
          ? { draftOnly: true, reviewWorkId: "work-1" }
          : {};
    setDesk(projectId, [tracked("a", "/a.md", extras)], "a");
    const scheme = _label === "Work prune" ? "scratch" : "manuscript";
    const rig = scenario({
      screen: "context",
      work: "work-1",
      scheme,
      path: "/a.md",
    });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme,
      path: "/a.md",
      workId: "work-1",
    });

    const removal = remove(rig.coordinator);
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toHaveLength(1);
    rig.coordinator.bindRouteSelection(projectId, revision, { kind: "server", documentId: "a" });

    expect((await removal).kind).toBe("empty-desk");
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toHaveLength(0);
    expect(rig.search()).toEqual({ screen: "context", work: "work-1" });
  });

  it("settles an exact pending receipt without removal when the revision confirms unbound", async () => {
    setDesk(projectId, [], null);
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/missing.md" });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/missing.md",
      workId: null,
    });
    const removal = rig.coordinator.acknowledgedDelete(projectId, ["deleted"]);
    rig.coordinator.confirmRouteUnbound(projectId, revision);
    expect((await removal).kind).toBe("noop");
  });

  it("settles pending cleanup without overwriting newer navigation", async () => {
    setDesk(projectId, [tracked("a", "/a.md"), tracked("b", "/b.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/a.md" });
    const oldRevision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: null,
    });
    const removal = rig.coordinator.acknowledgedDelete(projectId, ["a"]);

    rig.setSearch({ screen: "context", scheme: "manuscript", path: "/b.md" });
    const newRevision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/b.md",
      workId: null,
    });
    expect(newRevision).toBeGreaterThan(oldRevision);
    rig.coordinator.bindRouteSelection(projectId, newRevision, {
      kind: "server",
      documentId: "b",
    });

    expect((await removal).kind).not.toBe("noop");
    expect(useContextTabsStore.getState().byProject[projectId]).toMatchObject({
      tabs: [{ documentId: "b" }],
      activeTabId: "b",
    });
    expect(rig.search()).toMatchObject({ path: "/b.md" });
  });

  it("retains the route when its surface is inactive", async () => {
    setDesk(projectId, [tracked("a", "/a.md"), tracked("b", "/b.md")], "a");
    const rig = scenario({ screen: "chat", scheme: "manuscript", path: "/a.md" });
    bind(rig.coordinator, "/a.md", "a");

    await rig.coordinator.acknowledgedDelete(projectId, ["a"]);
    expect(rig.search()).toEqual({ screen: "chat", scheme: "manuscript", path: "/a.md" });
    expect(useContextTabsStore.getState().byProject[projectId]?.activeTabId).toBe("b");
  });

  it("settles a pending delete against a replacement without repairing its locator", async () => {
    setDesk(projectId, [tracked("old", "/same.md"), tracked("z", "/z.md")], "old");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/same.md" });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/same.md",
      workId: null,
    });
    const removal = rig.coordinator.acknowledgedDelete(projectId, ["old"]);
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "replacement",
    });

    expect((await removal).kind).toBe("active-fallback");
    expect(rig.search().path).toBe("/same.md");
  });

  it("lets newer navigation defeat a delayed repair", async () => {
    setDesk(projectId, [tracked("a", "/a.md"), tracked("b", "/b.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/a.md" });
    bind(rig.coordinator, "/a.md", "a");
    rig.delayRepairs();
    await rig.coordinator.acknowledgedDelete(projectId, ["a"]);
    rig.setSearch({ screen: "chat" });
    rig.flushRepair();
    expect(rig.search()).toEqual({ screen: "chat" });
  });

  it("prunes only foreign Work-scoped tabs from the platform-neutral command", async () => {
    setDesk(
      projectId,
      [
        tracked("project", "/chapter.md"),
        tracked("current", "/current.md", { scheme: "scratch", workId: "work-1" }),
        tracked("foreign", "/foreign.md", { scheme: "uploads", workId: "work-2" }),
      ],
      "project",
    );
    const rig = scenario();

    await rig.coordinator.pruneWork(projectId, "work-1");
    expect(
      useContextTabsStore.getState().byProject[projectId]?.tabs.map((tab) => tab.documentId),
    ).toEqual(["project", "current"]);
  });

  it("enforces draft ownership for discard and apply metadata", async () => {
    setDesk(
      projectId,
      [tracked("draft", "/draft.md", { draftOnly: true, reviewWorkId: "work-1" })],
      "draft",
    );
    const rig = scenario();

    expect((await rig.coordinator.discardDraft(projectId, "work-2", "draft")).kind).toBe("noop");
    rig.coordinator.applyDraftMetadata(projectId, "work-2", "draft");
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs[0]).toMatchObject({
      draftOnly: true,
    });
    rig.coordinator.applyDraftMetadata(projectId, "work-1", "draft");
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs[0]).not.toHaveProperty(
      "draftOnly",
    );
  });

  it("isolates projects and token-guards release across registration replay", async () => {
    setDesk("project-a", [tracked("a", "/a.md")], "a");
    setDesk("project-b", [tracked("b", "/b.md")], "b");
    const rig = scenario();
    const first = rig.coordinator.registerRoutePort("project-a", rig.route, null);
    const second = rig.coordinator.registerRoutePort("project-a", rig.route, null);
    first.release();
    const revision = rig.coordinator.beginRouteSelection("project-a", {
      scheme: "manuscript",
      path: "/a.md",
      workId: null,
    });
    expect(revision).toBe(1);
    second.release();
    await rig.coordinator.acknowledgedDelete("project-b", ["b"]);
    expect(useContextTabsStore.getState().byProject["project-a"]?.tabs).toHaveLength(1);
    expect(useContextTabsStore.getState().byProject["project-b"]?.tabs).toHaveLength(0);
  });

  it("cancels pending commands on disposal and account change", async () => {
    setDesk(projectId, [tracked("a", "/a.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/a.md" });
    rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: null,
    });
    const pending = rig.coordinator.acknowledgedDelete(projectId, ["a"]);
    rig.coordinator.configureAccount("account-2");
    expect((await pending).kind).toBe("noop");
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toHaveLength(1);
    expect(rig.coordinator.getProjectSnapshot(projectId).selection.status).toBe("none");
  });

  it("resets registered route authority on account change and hydration reset", async () => {
    setDesk(projectId, [tracked("a", "/a.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/a.md" });
    const registration = rig.coordinator.registerRoutePort(projectId, rig.route, "work-1");
    const firstRevision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    const pending = rig.coordinator.writerClose(projectId, "a");

    rig.coordinator.configureAccount("account-2");
    expect((await pending).kind).toBe("noop");
    expect(rig.coordinator.getProjectSnapshot(projectId).selection).toMatchObject({
      status: "pending",
      revision: firstRevision + 1,
      locator: { path: "/a.md" },
    });

    rig.coordinator.resetForHydration();
    expect(rig.coordinator.getProjectSnapshot(projectId).selection).toMatchObject({
      status: "pending",
      revision: firstRevision + 2,
    });
    registration.release();
  });

  it("reconstructs project A cleanly after an A to B to A registration cycle", () => {
    const rig = scenario();
    const firstA = rig.coordinator.registerRoutePort("project-a", rig.route, "work-1");
    rig.coordinator.beginRouteSelection("project-a", {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    firstA.release();
    const projectB = rig.coordinator.registerRoutePort("project-b", rig.route, "work-1");
    projectB.release();
    const secondA = rig.coordinator.registerRoutePort("project-a", rig.route, "work-1");

    expect(rig.coordinator.getProjectSnapshot("project-a").selection).toEqual({
      status: "none",
      revision: 0,
    });
    secondA.release();
    expect(rig.coordinator.getProjectSnapshot("project-a")).toBe(
      rig.coordinator.getProjectSnapshot("absent"),
    );
  });
});
