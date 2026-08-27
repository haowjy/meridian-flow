import { beforeEach, describe, expect, it } from "vitest";
import { useContextTabsStore } from "./context-tabs-store";

describe("context tabs draft-only lifecycle", () => {
  beforeEach(() => {
    useContextTabsStore.setState({ byProject: {}, _deskHydrated: false });
  });

  it("clears the draft-only marker when a live tree tab refreshes the document", () => {
    const store = useContextTabsStore.getState();
    store.openTab("project-1", trackedTab(true));
    store.openTab("project-1", trackedTab(false));

    expect(useContextTabsStore.getState().byProject["project-1"]?.tabs).toEqual([
      trackedTab(false),
    ]);
  });

  it("resolves a draft-only tab only from its owning review Work", () => {
    const store = useContextTabsStore.getState();
    store.openTab("project-1", trackedTab(true));

    store.resolveDraftOnlyTab("project-1", "work-b", "document-1", "discarded");
    expect(useContextTabsStore.getState().byProject["project-1"]?.tabs).toEqual([trackedTab(true)]);

    store.resolveDraftOnlyTab("project-1", "work-a", "document-1", "discarded");
    expect(useContextTabsStore.getState().byProject["project-1"]?.tabs).toEqual([]);
  });
});

describe("context tab identity and removal commits", () => {
  beforeEach(() => {
    useContextTabsStore.setState({ byProject: {}, _deskHydrated: false });
  });

  it("replaces a server identity at an occupied canonical locator in place", () => {
    const store = useContextTabsStore.getState();
    store.openTab("project-1", trackedAt("old", "/same.md"));
    store.openTab("project-1", trackedAt("other", "/other.md"));
    store.selectTab("project-1", "old");

    store.openTab("project-1", trackedAt("replacement", "/same.md"));

    expect(useContextTabsStore.getState().byProject["project-1"]).toMatchObject({
      tabs: [{ documentId: "replacement" }, { documentId: "other" }],
      activeTabId: "replacement",
    });
    expect(
      store.commitContextRemoval("project-1", {
        documentIds: ["old"],
        activeTabId: "replacement",
      }),
    ).toEqual([]);
    expect(useContextTabsStore.getState().byProject["project-1"]?.tabs[0]?.documentId).toBe(
      "replacement",
    );
  });

  it("commits an exact multi-id removal and final selection once", () => {
    const store = useContextTabsStore.getState();
    store.replaceTabs("project-1", [
      trackedAt("a", "/a.md"),
      trackedAt("b", "/b.md"),
      trackedAt("c", "/c.md"),
    ]);
    store.selectTab("project-1", "b");

    const removed = store.commitContextRemoval("project-1", {
      documentIds: ["a", "b"],
      activeTabId: "c",
    });

    expect(removed.map((tab) => tab.documentId)).toEqual(["a", "b"]);
    expect(useContextTabsStore.getState().byProject["project-1"]).toMatchObject({
      tabs: [{ documentId: "c" }],
      activeTabId: "c",
    });
  });
});

function trackedTab(draftOnly: boolean) {
  return {
    kind: "tracked" as const,
    documentId: "document-1",
    scheme: "manuscript" as const,
    path: "/chapter.md",
    name: "chapter.md",
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
    ...(draftOnly ? { draftOnly: true, reviewWorkId: "work-a" } : {}),
  };
}

function trackedAt(documentId: string, path: string) {
  return {
    ...trackedTab(false),
    documentId,
    path,
    name: path.slice(1),
  };
}
