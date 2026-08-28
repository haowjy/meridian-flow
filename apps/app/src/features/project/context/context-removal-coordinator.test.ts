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

  it("never publishes candidate persistence across begin, supersede, leave, or rejection", () => {
    const reports: WorkingSetRoute[][] = [];
    let routes: WorkingSetRoute[] = [{ scheme: "kb", path: "/keep.md" }];
    const coordinator = new ContextRemovalCoordinator("account-1", {
      workingSet: {
        readRecentRoutes: () => routes,
        reconcileContextRoutes: (_projectId, input) => {
          routes = reconcileSnapshotContextRoutes(
            { recentRoutes: routes, lastThreadId: null },
            input,
          ).recentRoutes;
          reports.push([...routes]);
          return routes;
        },
      },
      route: {
        readSearch: () => ({
          screen: "context",
          work: "work-1",
          scheme: "kb",
          path: "/candidate-b.md",
        }),
        updateSearch: () => undefined,
      },
    });
    coordinator.changeWorkSelection(projectId, "work-1", null);
    reports.length = 0;
    const candidateA = coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/candidate-a.md",
      workId: "work-1",
    });
    coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/candidate-b.md",
      workId: "work-1",
    });
    coordinator.clearRouteSelection(projectId);
    expect(reports).toEqual([]);

    const rejectedRevision = coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/candidate-b.md",
      workId: "work-1",
    });
    expect(rejectedRevision).toBeGreaterThan(candidateA);
    coordinator.rejectRouteCandidate(projectId, rejectedRevision);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual([{ scheme: "kb", path: "/keep.md" }]);
    expect(reports.flat()).not.toContainEqual(expect.objectContaining({ path: "/candidate-a.md" }));
    expect(reports.flat()).not.toContainEqual(expect.objectContaining({ path: "/candidate-b.md" }));
  });

  it("lets a same-path replacement defeat a delayed candidate-rejection repair", () => {
    setDesk([tracked("knowledge", "/knowledge.md")], "knowledge");
    let routes: WorkingSetRoute[] = [{ scheme: "kb", path: "/knowledge.md" }];
    const delayedRepair: { current: ((latest: ProjectSearch) => ProjectSearch) | null } = {
      current: null,
    };
    const search: ProjectSearch = {
      screen: "context",
      work: "work-1",
      scheme: "manuscript",
      path: "/same.md",
    };
    const coordinator = new ContextRemovalCoordinator("account-1", {
      workingSet: {
        readRecentRoutes: () => routes,
        reconcileContextRoutes: (_projectId, input) => {
          routes = reconcileSnapshotContextRoutes(
            { recentRoutes: routes, lastThreadId: null },
            input,
          ).recentRoutes;
          return routes;
        },
      },
    });
    coordinator.registerRoutePort(
      projectId,
      {
        readSearch: () => search,
        updateSearch: (_projectId, update) => {
          delayedRepair.current = update;
        },
      },
      "work-1",
    );
    const locator = { scheme: "manuscript" as const, path: "/same.md", workId: "work-1" };
    const rejectedRevision = coordinator.beginRouteSelection(projectId, locator);
    coordinator.rejectRouteCandidate(projectId, rejectedRevision);
    expect(delayedRepair.current).not.toBeNull();

    setDesk([tracked("replacement", "/same.md")], "replacement");
    const replacementRevision = coordinator.beginRouteSelection(projectId, locator);
    coordinator.bindRouteSelection(projectId, replacementRevision, identityFor("replacement"));
    const snapshot = coordinator.getProjectSnapshot(projectId);
    coordinator.activate({
      projectId,
      selectionRevision: snapshot.selection.revision,
      transitionRevision: snapshot.transitionRevision,
      locator,
      identity: identityFor("replacement"),
      owner: { kind: "desk", documentId: "replacement" },
    });

    if (!delayedRepair.current) throw new Error("expected delayed candidate repair");
    expect(delayedRepair.current(search)).toEqual(search);
    expect(coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "bound", identity: { documentId: "replacement" } },
      admitted: locator,
    });
    expect(routes[0]).toEqual({ scheme: "manuscript", path: "/same.md" });
  });

  it("does not admit a candidate phone locator during an unrelated desk removal", () => {
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
    expect(rig.coordinator.getProjectSnapshot(projectId).admitted).toBeNull();
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

    rig.coordinator.rejectRouteCandidate(projectId, revision);
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
    ["bound-same", "phone", true, true],
    ["bound-other", "replacement", true, false],
    ["unbound", null, true, true],
  ])("reduces late same-revision admission after %s settlement", (_case, identity, removes, repairs) => {
    const rig = scenario({ screen: "context", work: "work-1", scheme: "kb", path: "/phone.md" });
    rig.coordinator.changeWorkSelection(projectId, "work-1", null);
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
      rig.coordinator.rejectRouteCandidate(projectId, revision);
    }

    admit(rig.coordinator, capture, ["phone"]);

    expect(rig.routes().some((route) => route.path === "/phone.md")).toBe(!removes);
    expect(rig.search().path === "/phone.md").toBe(!repairs);
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

    expect(rig.routes()).toEqual([{ scheme: "kb", path: "/phone.md" }]);
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
    else if (cause === "work-prune") rig.coordinator.changeWorkSelection(projectId, "work-2", null);
    else rig.coordinator.discardDraft(projectId, "work-1", "a");
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toEqual([]);
    expect(rig.routes()).toEqual([]);

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
        owner: { kind: "desk", documentId: "a" },
      }),
    ).toBe(false);
    expect(rig.coordinator.getProjectSnapshot(projectId).admitted).toBeNull();
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
      owner: { kind: "desk" as const, documentId: "b" },
    };

    expect(rig.coordinator.activate({ ...activation, transitionRevision: staleTransition })).toBe(
      false,
    );
    expect(rig.coordinator.activate({ ...activation, transitionRevision: freshTransition })).toBe(
      true,
    );
  });

  it("admits a bound phone route through route-only ownership without a desk tab", () => {
    const rig = scenario({
      screen: "context",
      work: "work-1",
      scheme: "manuscript",
      path: "/phone.md",
    });
    rig.coordinator.registerRoutePort(
      projectId,
      {
        readSearch: rig.search,
        updateSearch: (_projectId, update) => update(rig.search()),
      },
      "work-1",
    );
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/phone.md",
      workId: "work-1",
    });
    rig.coordinator.bindRouteSelection(projectId, revision, identityFor("phone"));
    const snapshot = rig.coordinator.getProjectSnapshot(projectId);

    expect(
      rig.coordinator.activate({
        projectId,
        selectionRevision: revision,
        transitionRevision: snapshot.transitionRevision,
        locator: { scheme: "manuscript", path: "/phone.md", workId: "work-1" },
        identity: identityFor("phone"),
        owner: { kind: "route-only" },
      }),
    ).toBe(true);
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs ?? []).toEqual([]);
    expect(rig.coordinator.getProjectSnapshot(projectId).admitted).toEqual({
      scheme: "manuscript",
      path: "/phone.md",
      workId: "work-1",
    });
    expect(rig.routes()).toEqual([{ scheme: "manuscript", path: "/phone.md" }]);
  });

  it("admits local untitled Scratch in memory without a working-set route", () => {
    setDesk([], null);
    const rig = scenario({ screen: "context", work: "work-1", scheme: "scratch", path: "" });
    rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-1",
    );
    setDesk([{ kind: "new", documentId: "untitled", name: "Untitled" }], "untitled");
    const locator = { scheme: "scratch" as const, path: "", workId: "work-1" };
    const revision = rig.coordinator.beginRouteSelection(projectId, locator);
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "local",
      documentId: "untitled",
    });
    const snapshot = rig.coordinator.getProjectSnapshot(projectId);

    expect(
      rig.coordinator.activate({
        projectId,
        selectionRevision: revision,
        transitionRevision: snapshot.transitionRevision,
        locator,
        identity: { kind: "local", documentId: "untitled" },
        owner: { kind: "desk", documentId: "untitled" },
      }),
    ).toBe(true);
    expect(rig.coordinator.getProjectSnapshot(projectId).admitted).toEqual(locator);
    expect(rig.routes()).toEqual([]);

    rig.coordinator.clearRouteSelection(projectId);
    expect(rig.coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "none" },
      admitted: locator,
    });
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

  it.each([
    ["different locator", "/c.md", "c"],
    ["same locator replacement", "/a.md", "b"],
  ])("keeps newer continuity after delayed exact A for %s", (_case, path, documentId) => {
    setDesk([tracked("a", "/a.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path });
    rig.setRoutes([{ scheme: "manuscript", path: "/a.md" }]);
    rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-1",
    );
    const oldRevision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: null,
    });
    rig.coordinator.bindRouteSelection(projectId, oldRevision, {
      kind: "server",
      documentId: "a",
    });
    const capture = rig.coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator: { scheme: "manuscript", path: "/a.md", workId: null },
      documentId: "a",
    });
    const nextRevision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path,
      workId: null,
    });
    rig.coordinator.bindRouteSelection(projectId, nextRevision, {
      kind: "server",
      documentId,
    });
    setDesk([tracked(documentId, path)], documentId);
    const beforeAdmission = rig.coordinator.getProjectSnapshot(projectId);
    rig.coordinator.activate({
      projectId,
      selectionRevision: beforeAdmission.selection.revision,
      transitionRevision: beforeAdmission.transitionRevision,
      locator: { scheme: "manuscript", path, workId: null },
      identity: { kind: "server", documentId },
      owner: { kind: "desk", documentId },
    });

    admit(rig.coordinator, capture, ["a"]);

    expect(rig.coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "bound", identity: { documentId } },
      admitted: { path },
    });
    expect(rig.routes()[0]).toEqual({ scheme: "manuscript", path });
    expect(rig.search().path).toBe(path);
  });

  it.each([
    "writer-close",
    "work-prune",
    "draft-discard",
  ] as const)("removes an already-bound routed tab for %s", (cause) => {
    const tab = {
      ...tracked("a", "/a.md"),
      ...(cause === "work-prune" ? { scheme: "scratch" as const, workId: "work-1" } : {}),
      ...(cause === "draft-discard" ? { draftOnly: true, reviewWorkId: "work-1" } : {}),
    };
    setDesk([tab], "a");
    const scheme = cause === "work-prune" ? "scratch" : "manuscript";
    const rig = scenario({ screen: "context", scheme, path: "/a.md", work: "work-1" });
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
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "a",
    });

    if (cause === "writer-close") rig.coordinator.writerClose(projectId, "a");
    else if (cause === "work-prune") rig.coordinator.changeWorkSelection(projectId, "work-2", null);
    else rig.coordinator.discardDraft(projectId, "work-1", "a");

    expect(rig.routes()).toEqual([]);
    expect(rig.coordinator.getProjectSnapshot(projectId).admitted).toBeNull();
    expect(rig.search()).toEqual(
      cause === "work-prune"
        ? { screen: "context", scheme: "scratch", path: "/a.md", work: "work-1" }
        : { screen: "context", work: "work-1" },
    );
  });

  it("makes invalid first command use terminal", () => {
    setDesk([tracked("a", "/a.md")], "a");
    const rig = scenario();
    const capture = rig.coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator: { scheme: "manuscript", path: "/a.md", workId: null },
      documentId: "a",
    });
    const invalid: AcknowledgedContextDeleteCommand = {
      ...capture,
      cause: "acknowledged-delete",
      confirmed: { status: "deleted", deletedDocumentIds: ["other"] },
    };
    expect(rig.coordinator.acceptAcknowledgedDelete(invalid)).toEqual({
      status: "rejected",
      reason: "invalid_proof",
    });
    expect(
      rig.coordinator.acceptAcknowledgedDelete({
        ...invalid,
        confirmed: { status: "deleted", deletedDocumentIds: ["a"] },
      }),
    ).toEqual({ status: "rejected", reason: "command_conflict" });
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toHaveLength(1);
  });

  it("retains exact removal authority across host release and drops it on account disposal", () => {
    const rig = scenario({
      screen: "context",
      work: "work-1",
      scheme: "kb",
      path: "/phone.md",
    });
    rig.setRoutes([{ scheme: "kb", path: "/phone.md" }]);
    const registration = rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-1",
    );
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/phone.md",
      workId: "work-1",
    });
    rig.coordinator.bindRouteSelection(projectId, revision, identityFor("phone"));
    const capture = rig.coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator: { scheme: "kb", path: "/phone.md", workId: "work-1" },
      documentId: "phone",
    });
    registration.release();
    admit(rig.coordinator, capture, ["phone"]);

    const next = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/phone.md",
      workId: "work-1",
    });
    expect(rig.routes()).toEqual([]);
    rig.coordinator.rejectRouteCandidate(projectId, next);
    expect(rig.routes()).toEqual([]);

    rig.coordinator.dispose();
    rig.coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/phone.md",
      workId: "work-1",
    });
    expect(rig.routes()).toEqual([]);
  });

  it.each([
    "home",
    "chat",
    "work",
  ])("keeps a registered host live through %s selection leave and retires a fence on return", () => {
    setDesk([tracked("a", "/a.md"), tracked("b", "/b.md")], "a");
    const rig = scenario();
    rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-1",
    );
    const first = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    rig.coordinator.bindRouteSelection(projectId, first, identityFor("a"));
    rig.coordinator.writerClose(projectId, "a");
    rig.coordinator.clearRouteSelection(projectId);

    const returned = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/b.md",
      workId: "work-1",
    });
    rig.coordinator.bindRouteSelection(projectId, returned, identityFor("b"));
    const snapshot = rig.coordinator.getProjectSnapshot(projectId);

    expect(snapshot.live).toBe(true);
    expect(
      rig.coordinator.activate({
        projectId,
        selectionRevision: returned,
        transitionRevision: snapshot.transitionRevision,
        locator: { scheme: "manuscript", path: "/b.md", workId: "work-1" },
        identity: identityFor("b"),
        owner: { kind: "desk", documentId: "b" },
      }),
    ).toBe(true);
    expect(rig.coordinator.getProjectSnapshot(projectId).removalFence).toBeNull();
  });

  it("prunes phone-only old-Work continuity without admitting the new candidate", () => {
    setDesk([], null);
    const rig = scenario();
    rig.setRoutes([{ scheme: "scratch", path: "/old.md", workId: "work-old" }]);
    const oldRevision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "scratch",
      path: "/old.md",
      workId: "work-old",
    });
    rig.coordinator.bindRouteSelection(projectId, oldRevision, identityFor("old"));

    const next = rig.coordinator.changeWorkSelection(projectId, "work-new", {
      scheme: "scratch",
      path: "/new.md",
      workId: "work-new",
    });

    expect(next).toBeTypeOf("number");
    expect(rig.routes()).toEqual([]);
    expect(rig.coordinator.getProjectSnapshot(projectId)).toMatchObject({
      selection: { status: "candidate", locator: { workId: "work-new", path: "/new.md" } },
      admitted: null,
    });
  });

  it.each([
    ["candidate", null, "/old.md"],
    ["candidate", null, "/new.md"],
    ["bound", "old", "/old.md"],
    ["bound", "old", "/new.md"],
    ["rejected", false, "/old.md"],
    ["rejected", false, "/new.md"],
    ["none", "none", "/old.md"],
    ["none", "none", "/new.md"],
  ])("keeps a new Work candidate out of durability from %s phone continuity", (_case, settlement, nextPath) => {
    setDesk([], null);
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const store = new DeviceWorkingSetStore(storage);
    store.setUser("account-1");
    store.adopt(projectId, {
      recentRoutes: [{ scheme: "scratch", path: "/old.md", workId: "work-old" }],
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
    if (settlement !== "none") {
      const oldRevision = coordinator.beginRouteSelection(projectId, {
        scheme: "scratch",
        path: "/old.md",
        workId: "work-old",
      });
      if (settlement === false) coordinator.rejectRouteCandidate(projectId, oldRevision);
      else if (typeof settlement === "string")
        coordinator.bindRouteSelection(projectId, oldRevision, identityFor(settlement));
    }

    coordinator.changeWorkSelection(projectId, "work-new", {
      scheme: "scratch",
      path: nextPath,
      workId: "work-new",
    });

    const reconstructed = new DeviceWorkingSetStore(storage);
    reconstructed.setUser("account-1");
    expect(reconstructed.read(projectId)?.snapshot.recentRoutes).toEqual([]);
    expect(coordinator.getProjectSnapshot(projectId).admitted).toBeNull();
  });

  it.each([
    "work-prune",
    "draft-discard",
    "writer-close",
  ] as const)("keeps unrelated remembered continuity through selection-none %s and registration reload", (cause) => {
    const tab = {
      ...tracked("removed", "/removed.md"),
      ...(cause === "work-prune" ? { scheme: "scratch" as const, workId: "work-old" } : {}),
      ...(cause === "draft-discard" ? { draftOnly: true, reviewWorkId: "work-old" } : {}),
    };
    setDesk([tab], null);
    const rig = scenario();
    rig.setRoutes([
      { scheme: "kb", path: "/keep.md" },
      ...(cause === "work-prune"
        ? [{ scheme: "scratch" as const, path: "/removed.md", workId: "work-old" }]
        : [{ scheme: "manuscript" as const, path: "/removed.md" }]),
    ]);
    const registration = rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-new",
    );
    rig.coordinator.clearRouteSelection(projectId);

    if (cause === "draft-discard") rig.coordinator.discardDraft(projectId, "work-old", "removed");
    else if (cause === "writer-close") rig.coordinator.writerClose(projectId, "removed");

    expect(rig.coordinator.getProjectSnapshot(projectId).admitted?.path).toBe("/keep.md");
    expect(rig.routes()[0]).toEqual({ scheme: "kb", path: "/keep.md" });
    registration.release();
    rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-new",
    );
    expect(rig.coordinator.getProjectSnapshot(projectId).admitted?.path).toBe("/keep.md");
  });

  it("makes a disposed coordinator inert against delayed commands and global ports", () => {
    const deskCommits: string[][] = [];
    const routeCommits: ReconcileContextRoutesInput[] = [];
    const coordinator = new ContextRemovalCoordinator("account-a", {
      desk: {
        read: () => ({ tabs: [tracked("a", "/a.md")], activeTabId: "a" }),
        commit: (_id, input) => {
          deskCommits.push([...input.documentIds]);
          return [];
        },
        resolveDraftApply: () => deskCommits.push(["draft"]),
      },
      workingSet: {
        readRecentRoutes: () => [{ scheme: "manuscript", path: "/a.md" }],
        reconcileContextRoutes: (_id, input) => {
          routeCommits.push(input);
          return [];
        },
      },
    });
    const revision = coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    coordinator.bindRouteSelection(projectId, revision, identityFor("a"));
    const capture = coordinator.captureDeleteInitiation(projectId, {
      kind: "file",
      locator: { scheme: "manuscript", path: "/a.md", workId: "work-1" },
      documentId: "a",
    });
    coordinator.dispose();
    routeCommits.length = 0;

    expect(
      coordinator.acceptAcknowledgedDelete({
        ...capture,
        cause: "acknowledged-delete",
        confirmed: { status: "deleted", deletedDocumentIds: ["a"] },
      }),
    ).toEqual({ status: "rejected", reason: "coordinator_disposed" });
    expect(coordinator.discardDraft(projectId, "work-1", "a")).toEqual({ kind: "noop" });
    coordinator.applyDraftMetadata(projectId, "work-1", "a");
    expect(deskCommits).toEqual([]);
    expect(routeCommits).toEqual([]);
  });

  it("allows writer-closed identity to reopen but keeps discarded drafts terminal", () => {
    setDesk([tracked("a", "/a.md")], "a");
    const writerRig = scenario();
    const writerRevision = writerRig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    writerRig.coordinator.bindRouteSelection(projectId, writerRevision, identityFor("a"));
    writerRig.coordinator.writerClose(projectId, "a");
    setDesk([tracked("a", "/a.md")], "a");
    const reopened = writerRig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    writerRig.coordinator.bindRouteSelection(projectId, reopened, identityFor("a"));
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toHaveLength(1);

    setDesk(
      [{ ...tracked("draft", "/draft.md"), draftOnly: true, reviewWorkId: "work-1" }],
      "draft",
    );
    const draftRig = scenario();
    const draftRevision = draftRig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/draft.md",
      workId: "work-1",
    });
    draftRig.coordinator.bindRouteSelection(projectId, draftRevision, identityFor("draft"));
    draftRig.coordinator.discardDraft(projectId, "work-1", "draft");
    setDesk(
      [{ ...tracked("draft", "/draft.md"), draftOnly: true, reviewWorkId: "work-1" }],
      "draft",
    );
    const stale = draftRig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/draft.md",
      workId: "work-1",
    });
    draftRig.coordinator.bindRouteSelection(projectId, stale, identityFor("draft"));
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toEqual([]);
  });
});

function identityFor(documentId: string) {
  return { kind: "server" as const, documentId };
}
