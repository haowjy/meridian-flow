import { beforeEach, describe, expect, it } from "vitest";

import { type ServerContextTab, useContextTabsStore } from "./context-tabs-store";

const PROJECT = "project-1";

function editableTab(overrides: Partial<ServerContextTab> = {}): ServerContextTab {
  return {
    kind: "tracked",
    documentId: "doc-1",
    scheme: "manuscript",
    path: "/chapter-1.md",
    name: "chapter-1.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    ...overrides,
  } as ServerContextTab;
}

function tabs() {
  return useContextTabsStore.getState().byProject[PROJECT]?.tabs ?? [];
}

beforeEach(() => {
  useContextTabsStore.setState({ byProject: {} });
});

describe("openTab draftOnly merge semantics", () => {
  it("preserves draftOnly when a later open omits the key", () => {
    const { openTab } = useContextTabsStore.getState();
    openTab(PROJECT, editableTab({ draftOnly: true }));
    // Tree-derived reopen (contextTabFromFile never sets draftOnly): the
    // spread merge must not silently clear the lifecycle marker.
    openTab(PROJECT, editableTab({ name: "renamed.md" }));
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0].draftOnly).toBe(true);
    expect(tabs()[0].name).toBe("renamed.md");
  });
});

describe("resolveDraftOnlyTab", () => {
  it("committed keeps the tab and clears the marker", () => {
    const { openTab, resolveDraftOnlyTab } = useContextTabsStore.getState();
    openTab(PROJECT, editableTab({ draftOnly: true }));
    resolveDraftOnlyTab(PROJECT, "doc-1", "committed");
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0].draftOnly).toBe(false);
  });

  it("discarded closes the tab", () => {
    const { openTab, resolveDraftOnlyTab } = useContextTabsStore.getState();
    openTab(PROJECT, editableTab({ draftOnly: true }));
    openTab(PROJECT, editableTab({ documentId: "doc-2", path: "/other.md", name: "other.md" }));
    resolveDraftOnlyTab(PROJECT, "doc-1", "discarded");
    expect(tabs().map((t) => t.documentId)).toEqual(["doc-2"]);
  });

  it("never closes a tab without the marker (discard on an existing document)", () => {
    const { openTab, resolveDraftOnlyTab } = useContextTabsStore.getState();
    openTab(PROJECT, editableTab());
    resolveDraftOnlyTab(PROJECT, "doc-1", "discarded");
    resolveDraftOnlyTab(PROJECT, "doc-1", "committed");
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0].draftOnly).toBeUndefined();
  });

  it("is a no-op for unknown documents", () => {
    const { openTab, resolveDraftOnlyTab } = useContextTabsStore.getState();
    openTab(PROJECT, editableTab());
    const before = useContextTabsStore.getState().byProject;
    resolveDraftOnlyTab(PROJECT, "missing", "discarded");
    expect(useContextTabsStore.getState().byProject).toBe(before);
  });
});

describe("new untitled tabs", () => {
  it("re-mints a colliding id without moving or deselecting the tab", () => {
    const { openTab, remintNewTab, selectTab } = useContextTabsStore.getState();
    openTab(PROJECT, { kind: "new", documentId: "new-1", name: "Untitled" });
    openTab(PROJECT, editableTab({ documentId: "doc-2" }));
    selectTab(PROJECT, "new-1");

    remintNewTab(PROJECT, "new-1", "new-2");

    expect(tabs().map((tab) => tab.documentId)).toEqual(["new-2", "doc-2"]);
    expect(useContextTabsStore.getState().byProject[PROJECT]?.activeTabId).toBe("new-2");
  });

  it("materializes in place without changing tab order or active identity", () => {
    const { openTab, materializeNewTab, selectTab } = useContextTabsStore.getState();
    openTab(PROJECT, { kind: "new", documentId: "new-1", name: "Untitled" });
    openTab(PROJECT, editableTab({ documentId: "doc-2" }));
    selectTab(PROJECT, "new-1");

    materializeNewTab(
      PROJECT,
      "new-1",
      editableTab({
        documentId: "new-1",
        scheme: "scratch",
        path: "/Untitled 1",
        name: "Untitled 1",
        workId: "work-1",
        provisionalName: true,
      }),
    );

    expect(tabs().map((tab) => tab.documentId)).toEqual(["new-1", "doc-2"]);
    expect(tabs()[0]).toMatchObject({
      kind: "tracked",
      name: "Untitled 1",
      provisionalName: true,
    });
    expect(useContextTabsStore.getState().byProject[PROJECT]?.activeTabId).toBe("new-1");
  });
});
