// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContextTabs, rehydrateEditorWorkspace, useContextTabsStore } from "@/client/stores";
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
    reviewItemKey: "draft-a",
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
      _workspaceHydrated: false,
    });
    useContextTabsStore.getState().openTab("project-a", draftTab());
  });

  it("promotes only the exact tab it was given and leaves a replacement overlay alone", async () => {
    const { coordinator } = rig();
    const applied = getContextTabs("project-a").tabs[0];
    if (applied?.kind !== "tracked") throw new Error("Expected tracked draft tab");
    await expect(coordinator.promoteAppliedDraft("project-a", applied)).resolves.toBe(true);

    useContextTabsStore.getState().openTab("project-a", draftTab("replacement"));
    const before = structuredClone(getContextTabs("project-a"));
    await expect(coordinator.promoteAppliedDraft("project-a", applied)).resolves.toBe(false);
    expect(getContextTabs("project-a")).toEqual(before);
  });

  it("keeps one tab per document through a join, and absorbs the hidden draft's tab", async () => {
    const store = useContextTabsStore.getState();
    const project = "project-join";
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
    // The join re-identifies N to D; D's draft-only tab is the same document.
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
    coordinator.admitDraftReview("project-a", opened.tab);
    select();

    // The removal guard no longer repairs the address away from the draft.
    expect(updateSearch).not.toHaveBeenCalled();
    expect(getContextTabs("project-a").tabs).toMatchObject([
      { documentId: "document-a", draftOnly: true },
    ]);
  });
});
