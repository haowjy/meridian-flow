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
