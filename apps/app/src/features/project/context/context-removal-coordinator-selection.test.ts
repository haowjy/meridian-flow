import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { type ContextTab, useContextTabsStore } from "@/client/stores";
import type { ReconcileContextRoutesInput } from "@/client/working-set";
import { reconcileSnapshotContextRoutes } from "@/client/working-set/store";
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

function setDesk(tabs: ContextTab[], selectedTabId: string | null) {
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
    replaceRecentRoutes: (_id: string, routes: readonly WorkingSetRoute[]) => [...routes],
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

describe("ContextRemovalCoordinator exact evidence protocol", () => {
  beforeEach(() => setDesk([], null));

  it("never publishes candidate persistence across begin, supersede, leave, or rejection", () => {
    const reports: WorkingSetRoute[][] = [];
    let routes: WorkingSetRoute[] = [{ documentId: "keep", scheme: "kb", path: "/keep.md" }];
    const coordinator = new ContextRemovalCoordinator("account-1", {
      workingSet: {
        readRecentRoutes: () => routes,
        replaceRecentRoutes: (_id: string, routes: readonly WorkingSetRoute[]) => [...routes],
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
    expect(reports[0]).toEqual([{ documentId: "keep", scheme: "kb", path: "/keep.md" }]);
    expect(reports.flat()).not.toContainEqual(expect.objectContaining({ path: "/candidate-a.md" }));
    expect(reports.flat()).not.toContainEqual(expect.objectContaining({ path: "/candidate-b.md" }));
  });

  it("lets a same-path replacement defeat a delayed candidate-rejection repair", () => {
    setDesk([tracked("knowledge", "/knowledge.md")], "knowledge");
    let routes: WorkingSetRoute[] = [
      { documentId: "knowledge", scheme: "kb", path: "/knowledge.md" },
    ];
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
        replaceRecentRoutes: (_id: string, routes: readonly WorkingSetRoute[]) => [...routes],
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
    expect(routes[0]).toEqual({
      documentId: "replacement",
      scheme: "manuscript",
      path: "/same.md",
    });
  });

  it.each([
    "writer-close",
    "work-prune",
    "draft-discard",
  ] as const)("settles the named %s command against its represented pending route", async (cause) => {
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
        ? { documentId: "a", scheme, path: "/a.md", workId: "work-1" }
        : { documentId: "a", scheme, path: "/a.md" },
    ]);
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme,
      path: "/a.md",
      workId: "work-1",
    });

    if (cause === "writer-close") rig.coordinator.writerClose(projectId, "a");
    else if (cause === "work-prune") rig.coordinator.changeWorkSelection(projectId, "work-2", null);
    else await rig.coordinator.discardDraft(projectId, "work-1", "a");
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
    expect(rig.routes()).toEqual([
      { documentId: "phone", scheme: "manuscript", path: "/phone.md" },
    ]);
  });

  it("admits local untitled Scratch in memory without a working-set route", () => {
    setDesk([], null);
    const rig = scenario({ screen: "context", work: "work-1", scheme: "scratch", path: "" });
    rig.coordinator.registerRoutePort(
      projectId,
      { readSearch: rig.search, updateSearch: () => undefined },
      "work-1",
    );
    setDesk(
      [{ kind: "new", documentId: "untitled", name: "Untitled", workId: "work-1" }],
      "untitled",
    );
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
});

function identityFor(documentId: string) {
  return { kind: "server" as const, documentId };
}

it.each([
  { rawWork: "none", workId: null },
  { rawWork: undefined, workId: "work-1" },
])("preserves raw $rawWork authority through missing-route repair, phone activation, and relocation", async ({
  rawWork,
  workId,
}) => {
  setDesk([], null);
  const rig = scenario({
    screen: "context",
    work: rawWork,
    scheme: "uploads",
    path: "/missing.png",
  });
  rig.coordinator.registerRoutePort(projectId, rig.route, workId);
  const missing = rig.coordinator.beginRouteSelection(projectId, {
    scheme: "uploads",
    path: "/missing.png",
    workId,
  });
  rig.coordinator.rejectRouteCandidate(projectId, missing);
  expect(rig.search().path).toBeUndefined();
  expect(rig.search().work).toBe(rawWork);

  rig.route.updateSearch(projectId, (search) => ({
    ...search,
    scheme: "uploads",
    path: "/Map.png",
  }));
  const locator = { scheme: "uploads" as const, path: "/Map.png", workId };
  const revision = rig.coordinator.beginRouteSelection(projectId, locator);
  rig.coordinator.bindRouteSelection(projectId, revision, identityFor("image"));
  expect(
    rig.coordinator.activate({
      projectId,
      selectionRevision: revision,
      transitionRevision: rig.coordinator.getProjectSnapshot(projectId).transitionRevision,
      locator,
      identity: identityFor("image"),
      owner: { kind: "route-only" },
    }),
  ).toBe(true);
  expect(rig.routes()).toEqual([
    { documentId: "image", scheme: "uploads", path: "/Map.png", workId },
  ]);

  await rig.coordinator.reconcileDocumentAvailability([
    {
      kind: "available",
      projectId,
      commandId: "move-image",
      generation: "1",
      document: {
        kind: "file",
        entryId: "image",
        scope: workId ? { kind: "work", projectId, workId } : { kind: "none", projectId },
        sourceId: "source",
        parentId: "source",
        name: "Moved.png",
        aliases: [],
        path: ["Moved.png"],
        uri: `uploads://${workId ? "@work-1" : "@"}/Moved.png`,
        provisionalName: false,
        editable: false,
        disposition: "binary",
        fileType: "image",
        mimeType: "image/png",
      },
    },
  ]);
  expect(rig.search()).toMatchObject({ path: "/Moved.png", work: workId ?? "none" });
});
