// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContextTabs, selectedDocumentIdOf, useContextTabsStore } from "@/client/stores";
import type { ProjectSearch } from "../routing/project-route";
import { ContextRemovalCoordinator } from "./context-removal-coordinator";

function documentTab(documentId: string, path = `/${documentId}.md`) {
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

describe("draft-created document tabs", () => {
  beforeEach(() => {
    useContextTabsStore.setState({ byProject: {}, _workspaceHydrated: false });
  });

  it("keeps one tab per document when a device-made document joins a draft-created one", async () => {
    const store = useContextTabsStore.getState();
    const project = "project-join";
    store.openTab(project, documentTab("document-a", "/chapter.md"));
    await store.selectTab(project, "document-a");
    // New file: the device-minted document N, reserved under handle H.
    store.openTab(project, {
      kind: "new",
      documentId: "document-n",
      name: "chapter",
      resourceHandle: "handle-h",
    });
    await store.selectTab(project, "document-n");
    // The join re-identifies N to the draft-created document A.
    await store.reconcileResourceTab(project, "handle-h", {
      ...documentTab("document-a", "/chapter.md"),
      resourceHandle: "handle-h",
    });
    const slice = getContextTabs(project);
    expect(slice.tabs).toHaveLength(1);
    expect(slice.tabs[0]).toMatchObject({ documentId: "document-a", resourceHandle: "handle-h" });
    expect(selectedDocumentIdOf(slice)).toBe("document-a");
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
    const target = { scheme: "manuscript" as const, path: "/chapter.md" };
    const select = () => {
      const revision = coordinator.beginRouteSelection("project-a", target);
      coordinator.bindRouteSelection(
        "project-a",
        revision,
        { kind: "server", documentId: "document-a" },
        "answer",
      );
    };
    useContextTabsStore.getState().openTab("project-a", documentTab("document-a", "/chapter.md"));
    select();
    coordinator.discardDraft("project-a", "document-a");
    expect(getContextTabs("project-a").tabs).toEqual([]);
    updateSearch.mockClear();

    // The refused draft is still pending: Review installs its tab again.
    const opened = useContextTabsStore
      .getState()
      .openTab("project-a", documentTab("document-a", "/chapter.md"));
    if (opened.kind !== "opened" || opened.tab.kind !== "tracked") throw new Error("not opened");
    coordinator.admitDraftReview("project-a", opened.tab);
    select();

    // The removal guard no longer repairs the address away from the draft.
    expect(updateSearch).not.toHaveBeenCalled();
    expect(getContextTabs("project-a").tabs).toMatchObject([{ documentId: "document-a" }]);
  });
});
