import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContextTabs, useContextTabsStore } from "@/client/stores";
import type { ProjectSearch } from "../routing/project-route";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";

function draftTab(token = "tab-a") {
  return {
    kind: "tracked" as const,
    documentId: "document-a",
    scheme: "manuscript" as const,
    path: "/chapter.md",
    name: "chapter.md",
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
    draftOnly: true,
    reviewWorkId: "work-a",
    reviewDraftId: "draft-a",
    tabInstanceToken: token,
  };
}

function liveTab(documentId: string, path = `/${documentId}.md`) {
  return {
    kind: "tracked" as const,
    documentId,
    scheme: "manuscript" as const,
    path,
    name: path.slice(1),
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
  };
}

function rig() {
  return { coordinator: new ContextRemovalCoordinator("account-a") };
}

describe("draft tab settlement", () => {
  beforeEach(() => {
    useContextTabsStore.setState({
      byProject: {},
      _reviewOverlayByProject: {},
      _workspaceHydrated: false,
    });
    useContextTabsStore.getState().openTab("project-a", draftTab());
  });

  it("closes a discarded last draft-only tab, selects its neighbour, and replaces the address", async () => {
    // Order is [document-b, document-c, draft document-a]; the draft is last and selected.
    useContextTabsStore.getState().openTab("project-a", liveTab("document-b"));
    useContextTabsStore.getState().openTab("project-a", liveTab("document-c"));
    await useContextTabsStore.getState().reorderTabs("project-a", 0, 2);
    await useContextTabsStore.getState().selectTab("project-a", "work-a", "document-a");
    expect(getContextTabs("project-a").tabs.map((tab) => tab.documentId)).toEqual([
      "document-b",
      "document-c",
      "document-a",
    ]);
    let search: ProjectSearch = {
      screen: "context",
      scheme: "manuscript",
      path: "/chapter.md",
      work: "work-a",
    };
    const replaceAddress = vi.fn(
      (_projectId: string, update: (value: ProjectSearch) => ProjectSearch) => {
        search = update(search);
      },
    );
    const route = {
      readSearch: () => search,
      updateSearch: replaceAddress,
      transition: async () => ({ kind: "applied" as const }),
    };
    const coordinator = new ContextRemovalCoordinator("account-a", { route });
    coordinator.registerRoutePort("project-a", route, "work-a");
    const revision = coordinator.beginRouteSelection("project-a", {
      scheme: "manuscript",
      path: "/chapter.md",
      workId: "work-a",
    });
    coordinator.bindRouteSelection("project-a", revision, {
      kind: "server",
      documentId: "document-a",
    });

    expect(coordinator.discardDraft("project-a", "work-a", "document-a", "draft-a")).toMatchObject({
      kind: "active-fallback",
      fallback: { documentId: "document-c" },
    });
    expect(getContextTabs("project-a").tabs.map((tab) => tab.documentId)).toEqual([
      "document-b",
      "document-c",
    ]);
    expect(getContextTabs("project-a").selectedTabIdByWork["work-a"]).toBe("document-c");
    expect(search).toMatchObject({
      screen: "context",
      scheme: "manuscript",
      path: "/document-c.md",
    });
    expect(replaceAddress).toHaveBeenCalledOnce();
    // A confirmed Discard arrives after the optimistic close and finds nothing left.
    expect(coordinator.discardDraft("project-a", "work-a", "document-a", "draft-a")).toEqual({
      kind: "noop",
    });
  });

  it("promotes an applied draft overlay into the durable workspace", async () => {
    const { coordinator } = rig();
    const tab = getContextTabs("project-a").tabs[0];
    if (tab?.kind !== "tracked") throw new Error("Expected tracked draft tab");

    await expect(coordinator.promoteAppliedDraft("project-a", tab)).resolves.toBe(true);

    expect(useContextTabsStore.getState()._reviewOverlayByProject["project-a"]?.tabs ?? []).toEqual(
      [],
    );
    expect(useContextTabsStore.getState().byProject["project-a"]?.tabs).toMatchObject([
      { documentId: "document-a" },
    ]);
    expect(useContextTabsStore.getState().byProject["project-a"]?.tabs[0]).not.toHaveProperty(
      "draftOnly",
    );
  });

  it("keeps one draft-only membership whichever admission arrives first", () => {
    const store = useContextTabsStore.getState();
    const durable = () => useContextTabsStore.getState().byProject["project-a"]?.tabs ?? [];
    for (const overlayFirst of [false, true]) {
      useContextTabsStore.setState({ byProject: {}, _reviewOverlayByProject: {} });
      if (overlayFirst) {
        store.openTab("project-a", draftTab());
        store.openTab("project-a", liveTab("document-a", "/chapter.md"));
      } else {
        store.openTab("project-a", liveTab("document-a", "/chapter.md"));
        store.openTab("project-a", draftTab());
      }

      expect(durable()).toEqual([]);
      expect(getContextTabs("project-a").tabs).toMatchObject([
        { documentId: "document-a", draftOnly: true },
      ]);
      const outcome = new ContextRemovalCoordinator("account-a").discardDraft(
        "project-a",
        "work-a",
        "document-a",
        "draft-a",
      );
      expect(outcome.kind).not.toBe("noop");
      expect(getContextTabs("project-a").tabs).toEqual([]);
    }
  });

  it("lets an explicit Review re-open the draft of a refused Discard at the same address", () => {
    const search: ProjectSearch = {
      screen: "context",
      scheme: "manuscript",
      path: "/chapter.md",
      work: "work-a",
    };
    const updateSearch = vi.fn();
    const route = {
      readSearch: () => search,
      updateSearch,
      transition: async () => ({ kind: "applied" as const }),
    };
    const coordinator = new ContextRemovalCoordinator("account-a", { route });
    coordinator.registerRoutePort("project-a", route, "work-a");
    const target = { scheme: "manuscript" as const, path: "/chapter.md", workId: "work-a" };
    const select = () => {
      const revision = coordinator.beginRouteSelection("project-a", target);
      coordinator.bindRouteSelection("project-a", revision, {
        kind: "server",
        documentId: "document-a",
      });
    };
    select();
    coordinator.discardDraft("project-a", "work-a", "document-a", "draft-a");
    expect(getContextTabs("project-a").tabs).toEqual([]);
    updateSearch.mockClear();

    // The refused draft is still pending: Review installs its overlay again.
    const opened = useContextTabsStore.getState().openTab("project-a", draftTab("reopened"));
    if (opened.kind !== "opened" || opened.tab.kind !== "tracked") throw new Error("not opened");
    coordinator.admitDraftReview("project-a", opened.tab);
    select();

    // The removal guard no longer repairs the address away from the draft.
    expect(updateSearch).not.toHaveBeenCalled();
    expect(getContextTabs("project-a").tabs).toMatchObject([
      { documentId: "document-a", draftOnly: true },
    ]);
  });
});
