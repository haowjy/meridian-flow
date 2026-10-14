// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  editorTabsForWork,
  getContextTabs,
  rehydrateEditorWorkspace,
  useContextTabsStore,
} from "@/client/stores";
import type { ProjectSearch } from "../routing/project-route";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";

function draftTab(token = "tab-a", workId = "work-a", itemKey = "draft-a") {
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
    reviews: { [workId]: { itemKey, tabInstanceToken: token } },
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
      _workspaceHydrated: false,
    });
    useContextTabsStore.getState().openTab("project-a", draftTab());
  });

  it("promotes only the exact tab instance it was given and leaves a reopened draft-only tab alone", async () => {
    const { coordinator } = rig();
    const applied = getContextTabs("project-a").tabs[0];
    if (applied?.kind !== "tracked") throw new Error("Expected tracked draft tab");
    await expect(coordinator.promoteAppliedDraft("project-a", applied)).resolves.toBe(true);

    useContextTabsStore.getState().openTab("project-a", draftTab("replacement"));
    const before = structuredClone(getContextTabs("project-a"));
    await expect(coordinator.promoteAppliedDraft("project-a", applied)).resolves.toBe(false);
    expect(getContextTabs("project-a")).toEqual(before);
  });

  it.each([
    "draft-only",
    "promoted first",
  ])("keeps one tab per document through a join (%s)", async (order) => {
    const store = useContextTabsStore.getState();
    const project = `project-join-${order}`;
    const distinct = () => {
      const ids = getContextTabs(project).tabs.map((tab) => tab.documentId);
      expect(new Set(ids).size).toBe(ids.length);
    };
    store.openTab(project, draftTab());
    await store.selectTab(project, "work-a", "document-a");
    // New file: the device-minted document N, reserved under handle H.
    store.openTab(project, {
      kind: "new",
      documentId: "document-n",
      name: "chapter",
      resourceHandle: "handle-h",
    });
    await store.selectTab(project, "work-a", "document-n");
    distinct();
    // The join re-identifies N to D; D's tab (draft-only, or already promoted by the
    // replica showing D) is the same document.
    if (order === "promoted first") {
      const draft = getContextTabs(project).tabs[0];
      if (draft?.kind !== "tracked") throw new Error("Expected the draft tab");
      await store.settleDraft(project, draft);
    }
    await store.reconcileResourceTab(project, "handle-h", {
      ...liveTab("document-a", "/chapter.md"),
      resourceHandle: "handle-h",
    });
    distinct();
    const slice = getContextTabs(project);
    expect(slice.tabs).toHaveLength(1);
    expect(slice.tabs[0]).toMatchObject({ documentId: "document-a", resourceHandle: "handle-h" });
    expect(slice.tabs[0]?.draftOnly).toBeUndefined();
    expect(slice.selectedTabIdByWork).toEqual({ "work-a": "document-a" });
  });

  it("keeps one tab per document with an entry per Work, so Works neither take nor close each other's", async () => {
    const coordinator = new ContextRemovalCoordinator("account-a");
    const store = useContextTabsStore.getState();
    const inWork = (workId: string) =>
      editorTabsForWork(getContextTabs("project-a").tabs, workId).map((tab) => tab.documentId);
    store.openTab("project-a", draftTab("tab-b", "work-b", "draft-b"));
    const tabs = getContextTabs("project-a").tabs;
    expect(tabs).toHaveLength(1);
    expect(inWork("work-a")).toEqual(["document-a"]);
    expect(inWork("work-b")).toEqual(["document-a"]);
    expect(tabs[0]).toMatchObject({
      reviews: {
        "work-a": { itemKey: "draft-a", tabInstanceToken: "tab-a" },
        "work-b": { itemKey: "draft-b", tabInstanceToken: "tab-b" },
      },
    });

    // Discard in A leaves B's entry and tab; A no longer shows it.
    coordinator.discardDraft("project-a", "work-a", "draft-a");
    expect(inWork("work-a")).toEqual([]);
    expect(inWork("work-b")).toEqual(["document-a"]);
    // A writer's close in A drops A's entry the same way.
    store.openTab("project-a", draftTab());
    coordinator.changeWorkSelection("project-a", "work-a", null);
    coordinator.writerClose("project-a", getContextTabs("project-a").tabs[0] as never);
    expect(inWork("work-a")).toEqual([]);
    expect(inWork("work-b")).toEqual(["document-a"]);
    // The last entry's Discard closes the tab.
    coordinator.discardDraft("project-a", "work-b", "draft-b");
    expect(getContextTabs("project-a").tabs).toEqual([]);

    // Apply in A settles the one tab for every Work.
    store.openTab("project-a", draftTab());
    store.openTab("project-a", draftTab("tab-b", "work-b", "draft-b"));
    const shared = getContextTabs("project-a").tabs[0];
    if (shared?.kind !== "tracked") throw new Error("Expected tracked draft tab");
    await coordinator.promoteAppliedDraft("project-a", {
      ...shared,
      reviews: { "work-a": shared.reviews!["work-a"]! },
    });
    expect(getContextTabs("project-a").tabs).toHaveLength(1);
    expect(getContextTabs("project-a").tabs[0]?.draftOnly).toBeUndefined();
    expect(inWork("work-a")).toEqual(["document-a"]);
    expect(inWork("work-b")).toEqual(["document-a"]);
  });

  it("never persists a draft-only tab, so a reload reopens it from its review address", async () => {
    await rehydrateEditorWorkspace("account-persist");
    const store = useContextTabsStore.getState();
    store.openTab("project-a", draftTab());
    store.openTab("project-a", liveTab("document-b"));
    const stored = JSON.stringify(
      Object.values(sessionStorage).map((value) => JSON.parse(value as string)),
    );
    expect(stored).not.toContain("document-a");
    expect(stored).toContain("document-b");
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
    coordinator.discardDraft("project-a", "work-a", "draft-a");
    expect(getContextTabs("project-a").tabs).toEqual([]);
    updateSearch.mockClear();

    // The refused draft is still pending: Review installs its overlay again.
    const opened = useContextTabsStore.getState().openTab("project-a", draftTab("reopened"));
    if (opened.kind !== "opened" || opened.tab.kind !== "tracked") throw new Error("not opened");
    coordinator.admitDraftReview("project-a", opened.tab, "work-a");
    select();

    // The removal guard no longer repairs the address away from the draft.
    expect(updateSearch).not.toHaveBeenCalled();
    expect(getContextTabs("project-a").tabs).toMatchObject([
      { documentId: "document-a", draftOnly: true },
    ]);
  });
});
