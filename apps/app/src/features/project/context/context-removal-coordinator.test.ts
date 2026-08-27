import type { WorkingSetRoute } from "@meridian/contracts/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { type ContextTab, useContextTabsStore } from "@/client/stores";
import type { ProjectSearch } from "../routing/project-route";
import {
  ContextRemovalCoordinator,
  type ContextRemovalPlannerInput,
  type ContextRemovalWorkingSetPort,
  planContextRemoval,
} from "./context-removal-coordinator";

const projectId = "project-1";

function tracked(documentId: string, path: string, extras: Partial<ContextTab> = {}): ContextTab {
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
  } as ContextTab;
}

function freshDesk(tabs: ContextTab[], activeTabId: string | null) {
  useContextTabsStore.setState({
    byProject: { [projectId]: { tabs, activeTabId } },
    _deskHydrated: false,
  });
}

function scenario(search: ProjectSearch = { screen: "context" }) {
  let currentSearch = search;
  let routes: WorkingSetRoute[] = [];
  let reconcileCount = 0;
  const workingSet: ContextRemovalWorkingSetPort = {
    reconcileContextRoutes: (_projectId, input) => {
      reconcileCount += 1;
      const owned = (route: WorkingSetRoute) =>
        input.survivingOwnedLocators.some(
          (candidate) =>
            candidate.scheme === route.scheme &&
            candidate.path === route.path &&
            candidate.workId === route.workId,
        );
      routes = input.clearAll
        ? []
        : routes.filter(
            (route) =>
              !input.removedLocators.some(
                (removed) =>
                  removed.scheme === route.scheme &&
                  removed.path === route.path &&
                  removed.workId === route.workId,
              ) || owned(route),
          );
      if (input.promote) {
        routes = [
          input.promote,
          ...routes.filter(
            (route) =>
              route.scheme !== input.promote?.scheme ||
              route.path !== input.promote.path ||
              route.workId !== input.promote.workId,
          ),
        ];
      }
      return routes;
    },
  };
  const coordinator = new ContextRemovalCoordinator({
    workingSet,
    route: {
      readSearch: () => currentSearch,
      updateSearch: (_projectId, update) => {
        currentSearch = update(currentSearch);
      },
    },
  });
  return {
    coordinator,
    search: () => currentSearch,
    setSearch: (next: ProjectSearch) => {
      currentSearch = next;
    },
    routes: () => routes,
    setRoutes: (next: WorkingSetRoute[]) => {
      routes = next;
    },
    reconcileCount: () => reconcileCount,
  };
}

describe("ContextRemovalCoordinator", () => {
  beforeEach(() => freshDesk([], null));

  it("keeps route and active selection for an inactive acknowledged deletion", async () => {
    freshDesk([tracked("a", "/a.md"), tracked("b", "/b.md")], "b");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/b.md" });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/b.md",
      workId: null,
    });
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "b",
    });

    const outcome = await rig.coordinator.executeContextRemoval(projectId, {
      cause: "acknowledged-delete",
      documentIds: ["a"],
    });

    expect(outcome.kind).toBe("inactive-removal");
    expect(useContextTabsStore.getState().byProject[projectId]).toMatchObject({
      tabs: [{ documentId: "b" }],
      activeTabId: "b",
    });
    expect(rig.search().path).toBe("/b.md");
  });

  it("anchors route fallback around the routed tab when desk selection lags", async () => {
    freshDesk([tracked("a", "/a.md"), tracked("b", "/b.md"), tracked("c", "/c.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/b.md" });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/b.md",
      workId: null,
    });
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "b",
    });

    const outcome = await rig.coordinator.executeContextRemoval(projectId, {
      cause: "acknowledged-delete",
      documentIds: ["b"],
    });

    expect(outcome).toMatchObject({
      kind: "active-fallback",
      deskActiveRemoved: false,
      routedDocumentRemoved: true,
      fallback: { documentId: "c" },
    });
    expect(useContextTabsStore.getState().byProject[projectId]?.activeTabId).toBe("c");
    expect(rig.search().path).toBe("/c.md");
  });

  it("converges stale desk selection to a surviving routed tab without navigation", async () => {
    freshDesk([tracked("a", "/a.md"), tracked("c", "/c.md"), tracked("b", "/b.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/b.md" });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/b.md",
      workId: null,
    });
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "b",
    });

    const outcome = await rig.coordinator.executeContextRemoval(projectId, {
      cause: "acknowledged-delete",
      documentIds: ["a"],
    });

    expect(outcome).toMatchObject({
      kind: "active-fallback",
      deskActiveRemoved: true,
      routedDocumentRemoved: false,
      fallback: { documentId: "b" },
    });
    expect(useContextTabsStore.getState().byProject[projectId]?.activeTabId).toBe("b");
    expect(rig.search().path).toBe("/b.md");
  });

  it("does not rewrite a lagging desk selection for a true inactive removal", async () => {
    freshDesk([tracked("a", "/a.md"), tracked("b", "/b.md"), tracked("c", "/c.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/b.md" });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/b.md",
      workId: null,
    });
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "b",
    });

    expect(
      await rig.coordinator.executeContextRemoval(projectId, {
        cause: "acknowledged-delete",
        documentIds: ["c"],
      }),
    ).toMatchObject({ kind: "inactive-removal" });
    expect(useContextTabsStore.getState().byProject[projectId]?.activeTabId).toBe("a");
    expect(rig.search().path).toBe("/b.md");
  });

  it.each([
    [["a", "b", "c"], "b", "/c.md"],
    [["a", "b"], "b", "/a.md"],
  ] as const)("falls back right then left from a routed removal", async (ids, removed, path) => {
    freshDesk(
      ids.map((id) => tracked(id, `/${id}.md`)),
      removed,
    );
    const rig = scenario({ screen: "context", scheme: "manuscript", path: `/${removed}.md` });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: `/${removed}.md`,
      workId: null,
    });
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: removed,
    });

    const outcome = await rig.coordinator.executeContextRemoval(projectId, {
      cause: "acknowledged-delete",
      documentIds: [removed],
    });

    expect(outcome.kind).toBe("active-fallback");
    expect(rig.search().path).toBe(path);
  });

  it("distinguishes an empty desk and a route-only phone removal", async () => {
    freshDesk([tracked("a", "/a.md")], "a");
    const deskRig = scenario({ screen: "context", scheme: "manuscript", path: "/a.md" });
    let revision = deskRig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: null,
    });
    deskRig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "a",
    });
    expect(
      await deskRig.coordinator.executeContextRemoval(projectId, {
        cause: "acknowledged-delete",
        documentIds: ["a"],
      }),
    ).toMatchObject({ kind: "empty-desk", remaining: [] });
    expect(deskRig.search()).toEqual({ screen: "context" });

    freshDesk([], null);
    const phoneRig = scenario({ screen: "context", scheme: "kb", path: "/phone.md" });
    revision = phoneRig.coordinator.beginRouteSelection(projectId, {
      scheme: "kb",
      path: "/phone.md",
      workId: null,
    });
    phoneRig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "phone",
    });
    expect(
      await phoneRig.coordinator.executeContextRemoval(projectId, {
        cause: "acknowledged-delete",
        documentIds: ["phone"],
      }),
    ).toMatchObject({ kind: "route-only-removal" });
    expect(phoneRig.search()).toEqual({ screen: "context" });
  });

  it("preserves new and draft-only tabs for deletion but removes them for eligible causes", async () => {
    const newTab: ContextTab = { kind: "new", documentId: "new", name: "Untitled" };
    const draft = tracked("draft", "/draft.md", {
      draftOnly: true,
      reviewWorkId: "work-1",
    });
    freshDesk([newTab, draft, tracked("server", "/server.md")], "server");
    const rig = scenario();

    expect(
      await rig.coordinator.executeContextRemoval(projectId, {
        cause: "acknowledged-delete",
        documentIds: ["new", "draft", "server"],
      }),
    ).toMatchObject({ kind: "active-fallback", fallback: { documentId: "draft" } });
    expect(
      useContextTabsStore.getState().byProject[projectId]?.tabs.map((tab) => tab.documentId),
    ).toEqual(["new", "draft"]);
    await rig.coordinator.executeContextRemoval(projectId, {
      cause: "draft-discard",
      documentIds: ["draft"],
    });
    await rig.coordinator.executeContextRemoval(projectId, {
      cause: "writer-close",
      documentIds: ["new"],
    });
    expect(useContextTabsStore.getState().byProject[projectId]?.tabs).toEqual([]);
  });

  it("repairs a bound local new-tab route on writer close", async () => {
    const newTab: ContextTab = { kind: "new", documentId: "new", name: "Untitled" };
    freshDesk([newTab, tracked("b", "/b.md")], "new");
    const rig = scenario({ screen: "context", scheme: "scratch", path: "" });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "scratch",
      path: "",
      workId: null,
    });
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "local",
      documentId: "new",
    });

    const outcome = await rig.coordinator.executeContextRemoval(projectId, {
      cause: "writer-close",
      documentIds: ["new"],
    });

    expect(outcome).toMatchObject({
      kind: "active-fallback",
      routedDocumentRemoved: true,
      fallback: { documentId: "b" },
    });
    expect(rig.search()).toMatchObject({ scheme: "manuscript", path: "/b.md" });
  });

  it("keeps tree and cache state outside the removal planner contract", () => {
    const input = {
      tabs: [tracked("a", "/a.md")],
      activeTabId: "a",
      routeSelection: { status: "none" as const, revision: 0 },
      intent: { cause: "acknowledged-delete" as const, documentIds: ["a"] },
    } satisfies ContextRemovalPlannerInput;

    expect(Object.keys(input).sort()).toEqual(["activeTabId", "intent", "routeSelection", "tabs"]);
    expect(planContextRemoval(input).outcome.kind).toBe("empty-desk");
  });

  it("resolves draft apply as metadata without entering removal policy", () => {
    const draft = tracked("draft", "/draft.md", {
      draftOnly: true,
      reviewWorkId: "work-1",
    });
    freshDesk([draft], "draft");
    const rig = scenario();

    rig.coordinator.resolveDraftApply(projectId, "work-1", "draft");

    expect(useContextTabsStore.getState().byProject[projectId]).toEqual({
      tabs: [tracked("draft", "/draft.md")],
      activeTabId: "draft",
    });
    expect(rig.reconcileCount()).toBe(0);
  });

  it("atomically cleans working-set routes without deleting a locator still owned by a survivor", async () => {
    freshDesk([tracked("a", "/same.md"), tracked("b", "/other.md")], "b");
    const rig = scenario();
    rig.setRoutes([
      { scheme: "manuscript", path: "/same.md" },
      { scheme: "manuscript", path: "/other.md" },
    ]);
    await rig.coordinator.executeContextRemoval(projectId, {
      cause: "acknowledged-delete",
      documentIds: ["a"],
    });
    expect(rig.routes()).toEqual([{ scheme: "manuscript", path: "/other.md" }]);
    expect(rig.reconcileCount()).toBe(1);
  });

  it("delays a pending same-path receipt and cancels repair when the route binds a replacement", async () => {
    freshDesk([tracked("a", "/same.md"), tracked("z", "/z.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/same.md" });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/same.md",
      workId: null,
    });
    let settled = false;
    const removal = rig.coordinator
      .executeContextRemoval(projectId, {
        cause: "acknowledged-delete",
        documentIds: ["a"],
      })
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "replacement",
    });
    expect((await removal).kind).toBe("active-fallback");
    expect(rig.search().path).toBe("/same.md");
  });

  it("lets newer search state defeat a delayed guarded repair", async () => {
    freshDesk([tracked("a", "/a.md"), tracked("b", "/b.md")], "a");
    const rig = scenario({ screen: "context", scheme: "manuscript", path: "/a.md" });
    const revision = rig.coordinator.beginRouteSelection(projectId, {
      scheme: "manuscript",
      path: "/a.md",
      workId: null,
    });
    rig.coordinator.bindRouteSelection(projectId, revision, {
      kind: "server",
      documentId: "a",
    });
    rig.setSearch({ screen: "home" });
    await rig.coordinator.executeContextRemoval(projectId, {
      cause: "acknowledged-delete",
      documentIds: ["a"],
    });
    expect(rig.search()).toEqual({ screen: "home" });
  });
});
