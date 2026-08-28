import { beforeEach, describe, expect, it } from "vitest";
import {
  commitDraftApplyMetadata,
  commitPlannedContextRemoval,
  useContextTabsStore,
} from "./context-tabs-store";

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

  it("resolves applied draft metadata only from its owning review Work", () => {
    const store = useContextTabsStore.getState();
    store.openTab("project-1", trackedTab(true));

    commitDraftApplyMetadata("project-1", "work-b", "document-1");
    expect(useContextTabsStore.getState().byProject["project-1"]?.tabs).toEqual([trackedTab(true)]);

    commitDraftApplyMetadata("project-1", "work-a", "document-1");
    expect(useContextTabsStore.getState().byProject["project-1"]?.tabs).toEqual([
      trackedTab(false),
    ]);
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
    store.selectTab("project-1", "work-1", "old");

    store.openTab("project-1", trackedAt("replacement", "/same.md"));

    expect(useContextTabsStore.getState().byProject["project-1"]).toMatchObject({
      tabs: [{ documentId: "replacement" }, { documentId: "other" }],
      selectedTabIdByWork: { "work-1": "replacement" },
    });
    expect(
      commitPlannedContextRemoval("project-1", {
        documentIds: ["old"],
        deskSelection: { workId: "work-1", documentId: "replacement" },
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
    store.selectTab("project-1", "work-1", "b");

    const removed = commitPlannedContextRemoval("project-1", {
      documentIds: ["a", "b"],
      deskSelection: { workId: "work-1", documentId: "c" },
    });

    expect(removed.map((tab) => tab.documentId)).toEqual(["a", "b"]);
    expect(useContextTabsStore.getState().byProject["project-1"]).toMatchObject({
      tabs: [{ documentId: "c" }],
      selectedTabIdByWork: { "work-1": "c" },
    });
  });

  it("keeps independent Work selections and rewrites every reference on remint", () => {
    const store = useContextTabsStore.getState();
    store.openTab("project-1", { kind: "new", documentId: "local", name: "Untitled", workId: "a" });
    store.openTab("project-1", trackedAt("chapter", "/chapter.md"));
    store.selectTab("project-1", "a", "local");
    store.selectTab("project-1", "b", "chapter");
    store.remintNewTab("project-1", "local", "reminted");
    expect(useContextTabsStore.getState().byProject["project-1"]?.selectedTabIdByWork).toEqual({
      a: "reminted",
      b: "chapter",
    });
  });

  it("materializes in place with durable local origin and scrubs incompatible metadata", () => {
    const store = useContextTabsStore.getState();
    store.openTab("project-1", { kind: "new", documentId: "local", name: "Untitled", workId: "a" });
    store.selectTab("project-1", "a", "local");
    store.materializeNewTab("project-1", "local", {
      kind: "tracked",
      documentId: "local",
      scheme: "scratch",
      path: "/Untitled.md",
      name: "Untitled.md",
      workId: "a",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    });
    expect(useContextTabsStore.getState().byProject["project-1"]).toMatchObject({
      tabs: [{ documentId: "local", origin: "local-untitled" }],
      selectedTabIdByWork: { a: "local" },
    });

    store.updateTrackedTab("project-1", "local", { workId: "b" });
    expect(useContextTabsStore.getState().byProject["project-1"]?.selectedTabIdByWork).toEqual({});
  });

  it("removes every dangling selection atomically", () => {
    const store = useContextTabsStore.getState();
    store.openTab("project-1", trackedAt("chapter", "/chapter.md"));
    store.selectTab("project-1", "a", "chapter");
    store.selectTab("project-1", "b", "chapter");
    commitPlannedContextRemoval("project-1", { documentIds: ["chapter"] });
    expect(useContextTabsStore.getState().byProject["project-1"]).toEqual({
      tabs: [],
      selectedTabIdByWork: {},
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
