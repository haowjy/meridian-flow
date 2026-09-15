import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { type ContextTab, getContextTabs, useContextTabsStore } from "@/client/stores";
import type { ReconcileContextRoutesInput } from "@/client/working-set";
import { DeviceWorkingSetStore, reconcileSnapshotContextRoutes } from "@/client/working-set/store";
import { acceptContextTransition } from "@/test-support/context-removal-route";
import type { ProjectSearch } from "../routing/project-route";
import {
  ContextRemovalCoordinator,
  type ContextRemovalRoutePort,
} from "./context-removal-coordinator";

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

function setWorkspace(tabs: ContextTab[], selectedTabId: string | null) {
  const normalized = tabs.map((tab) =>
    tab.kind !== "new" && tab.draftOnly
      ? {
          ...tab,
          tabInstanceId: tab.tabInstanceId ?? `${tab.documentId}-instance`,
          reviewDraftId: tab.reviewDraftId ?? `${tab.documentId}-draft`,
          tabInstanceToken: tab.tabInstanceToken ?? `${tab.documentId}-token`,
        }
      : tab,
  );
  const durable = normalized.filter((tab) => !tab.draftOnly);
  const review = normalized.filter((tab) => tab.draftOnly);
  useContextTabsStore.setState({
    byProject: {
      [projectId]: {
        tabs: durable,
        selectedTabIdByWork:
          selectedTabId && durable.some((tab) => tab.documentId === selectedTabId)
            ? { "work-1": selectedTabId }
            : {},
      },
    },
    _reviewOverlayByProject:
      review.length === 0
        ? {}
        : {
            [projectId]: {
              tabs: review,
              selectedTabIdByWork: selectedTabId ? { "work-1": selectedTabId } : {},
            },
          },
    _workspaceHydrated: false,
  });
}

function scenario(initialSearch: ProjectSearch = { screen: "context" }) {
  let search = initialSearch;
  let routes: WorkingSetRoute[] = [];
  const route: ContextRemovalRoutePort = {
    transition: acceptContextTransition,
    readSearch: () => search,
    updateSearch: (_projectId, update) => {
      search = update(search);
    },
  };
  const workingSet = {
    readRecentRoutes: () => routes,
    replaceRecentRoutes: (_id: string, next: readonly WorkingSetRoute[]) => {
      routes = [...next];
      return routes;
    },
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
    route,
    search: () => search,
    routes: () => routes,
    setRoutes: (next: WorkingSetRoute[]) => {
      routes = next;
    },
  };
}

describe("ContextRemovalCoordinator exact removal and lifetime", () => {
  beforeEach(() => setWorkspace([], null));

  it("terminal availability evicts server tabs while preserving local-new state", () => {
    const local: ContextTab = {
      kind: "new",
      documentId: "local-new",
      name: "Untitled",
      resourceHandle: "resource-local-new",
    };
    setWorkspace(
      [tracked("active", "/active.md"), tracked("background", "/background.md"), local],
      "active",
    );
    const rig = scenario({
      screen: "context",
      work: "work-1",
      scheme: "manuscript",
      path: "/active.md",
    });
    rig.setRoutes([
      { documentId: "active", scheme: "manuscript", path: "/active.md" },
      { documentId: "background", scheme: "manuscript", path: "/background.md" },
    ]);
    rig.coordinator.registerRoutePort(projectId, rig.route, "work-1");
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/active.md",
      workId: "work-1",
    });
    rig.coordinator.bindRouteSelection(projectId, revision, identityFor("active"));

    rig.coordinator.reconcileDocumentAvailability(
      ["active", "background", "local-new"].map((documentId) => ({
        kind: "terminal-remove" as const,
        commandId: `availability/v1/terminal-remove/${projectId}/${documentId}/8`,
        projectId,
        documentId,
        generation: "8",
        cause: "document-deleted" as const,
      })),
    );

    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toEqual([
      expect.objectContaining(local),
    ]);
    expect(rig.routes()).toEqual([]);
    expect(rig.coordinator.getProjectSnapshot(projectId).removalFence).toMatchObject({
      removedDocumentIds: ["active", "background"],
    });
  });

  it.each([
    "writer-close",
    "work-prune",
    "draft-discard",
  ] as const)("removes an already-bound routed tab for %s", async (cause) => {
    const tab = {
      ...tracked("a", "/a.md"),
      ...(cause === "work-prune" ? { scheme: "scratch" as const, workId: "work-1" } : {}),
      ...(cause === "draft-discard" ? { draftOnly: true, reviewWorkId: "work-1" } : {}),
    };
    setWorkspace([tab], "a");
    const scheme = cause === "work-prune" ? "scratch" : "manuscript";
    const rig = scenario({ screen: "context", scheme, path: "/a.md", work: "work-1" });
    rig.setRoutes([
      scheme === "scratch"
        ? { documentId: "a", scheme, path: "/a.md", workId: "work-1" }
        : { documentId: "a", scheme, path: "/a.md" },
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
    else await rig.coordinator.discardDraft(projectId, "work-1", "a");

    expect(rig.routes()).toEqual([]);
    expect(rig.coordinator.getProjectSnapshot(projectId).admitted).toBeNull();
    expect(rig.search()).toEqual(
      cause === "work-prune"
        ? { screen: "context", scheme: "scratch", path: "/a.md", work: "work-1" }
        : { screen: "context", work: "work-1" },
    );
  });

  it.each([
    "home",
    "chat",
    "work",
  ])("keeps a registered host live through %s selection leave and retires a fence on return", () => {
    setWorkspace([tracked("a", "/a.md"), tracked("b", "/b.md")], "a");
    const rig = scenario();
    rig.coordinator.registerRoutePort(
      projectId,
      {
        transition: acceptContextTransition,
        readSearch: rig.search,
        updateSearch: () => undefined,
      },
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
        owner: { kind: "workspace", documentId: "b" },
      }),
    ).toBe(true);
    expect(rig.coordinator.getProjectSnapshot(projectId).removalFence).toBeNull();
  });

  it("prunes phone-only old-Work continuity without admitting the new candidate", () => {
    setWorkspace([], null);
    const rig = scenario();
    rig.setRoutes([{ documentId: "old", scheme: "scratch", path: "/old.md", workId: "work-old" }]);
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
    setWorkspace([], null);
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    const store = new DeviceWorkingSetStore(storage);
    store.setUser("account-1");
    store.adopt(projectId, {
      recentRoutes: [{ documentId: "old", scheme: "scratch", path: "/old.md", workId: "work-old" }],
      lastThreadId: null,
    });
    const coordinator = new ContextRemovalCoordinator("account-1", {
      workingSet: {
        readRecentRoutes: () => store.read(projectId)?.snapshot.recentRoutes ?? [],
        replaceRecentRoutes: (_id: string, routes: readonly WorkingSetRoute[]) => [...routes],
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
  ] as const)("keeps unrelated remembered continuity through selection-none %s and registration reload", async (cause) => {
    const tab = {
      ...tracked("removed", "/removed.md"),
      ...(cause === "work-prune" ? { scheme: "scratch" as const, workId: "work-old" } : {}),
      ...(cause === "draft-discard" ? { draftOnly: true, reviewWorkId: "work-old" } : {}),
    };
    setWorkspace([tab], null);
    const rig = scenario();
    rig.setRoutes([
      { documentId: "keep", scheme: "kb", path: "/keep.md" },
      ...(cause === "work-prune"
        ? [
            {
              documentId: "removed",
              scheme: "scratch" as const,
              path: "/removed.md",
              workId: "work-old",
            },
          ]
        : [{ documentId: "removed", scheme: "manuscript" as const, path: "/removed.md" }]),
    ]);
    const registration = rig.coordinator.registerRoutePort(
      projectId,
      {
        transition: acceptContextTransition,
        readSearch: rig.search,
        updateSearch: () => undefined,
      },
      "work-new",
    );
    rig.coordinator.clearRouteSelection(projectId);

    if (cause === "draft-discard")
      await rig.coordinator.discardDraft(projectId, "work-old", "removed");
    else if (cause === "writer-close") rig.coordinator.writerClose(projectId, "removed");

    expect(rig.coordinator.getProjectSnapshot(projectId).admitted?.path).toBe("/keep.md");
    expect(rig.routes()[0]).toEqual({ documentId: "keep", scheme: "kb", path: "/keep.md" });
    registration.release();
    rig.coordinator.registerRoutePort(
      projectId,
      {
        transition: acceptContextTransition,
        readSearch: rig.search,
        updateSearch: () => undefined,
      },
      "work-new",
    );
    expect(rig.coordinator.getProjectSnapshot(projectId).admitted?.path).toBe("/keep.md");
  });

  it.each([
    false,
    true,
  ])("closes one review overlay without invalidating its sibling (durable underneath: %s)", async (durable) => {
    setWorkspace(
      [
        ...(durable ? [{ ...tracked("a", "/a.md"), tabInstanceId: "durable-a" }] : []),
        { ...tracked("a", "/a.md"), draftOnly: true, reviewWorkId: "work-1" },
        { ...tracked("b", "/b.md"), draftOnly: true, reviewWorkId: "work-1" },
      ],
      "a",
    );
    const rig = scenario({
      screen: "context",
      scheme: "manuscript",
      path: "/a.md",
      work: "work-1",
    });
    rig.coordinator.changeWorkSelection(projectId, "work-1", {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    rig.coordinator.bindRouteSelection(projectId, revision, identityFor("a"));
    const before = getContextTabs(projectId);
    const accept = rig.route.transition;
    let resume!: () => Promise<unknown>;
    rig.route.transition = (id, target, prepared) =>
      new Promise((resolve) => {
        resume = async () => resolve(await accept.call(rig.route, id, target, prepared));
      });
    const closing = rig.coordinator.writerClose(projectId, "a");
    if (!durable) {
      expect(getContextTabs(projectId)).toBe(before);
      await resume();
      await expect(closing).resolves.toEqual({ kind: "applied" });
    }
    const after = getContextTabs(projectId);
    expect(after.tabs).toHaveLength(durable ? 2 : 1);
    expect(after.tabs.find((tab) => tab.documentId === "a")?.tabInstanceId).toBe(
      durable ? "durable-a" : undefined,
    );
    expect(after.tabs.find((tab) => tab.documentId === "b")?.draftOnly).toBe(true);
  });

  it("allows writer-closed identity to reopen but keeps discarded drafts terminal", async () => {
    setWorkspace([tracked("a", "/a.md")], "a");
    const writerRig = scenario();
    const writerRevision = writerRig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    writerRig.coordinator.bindRouteSelection(projectId, writerRevision, identityFor("a"));
    writerRig.coordinator.writerClose(projectId, "a");
    setWorkspace([tracked("a", "/a.md")], "a");
    const reopened = writerRig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: "work-1",
    });
    writerRig.coordinator.bindRouteSelection(projectId, reopened, identityFor("a"));
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toHaveLength(1);

    setWorkspace(
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
    await draftRig.coordinator.discardDraft(projectId, "work-1", "draft");
    setWorkspace(
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
