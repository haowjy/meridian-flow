/**
 * context-tabs-store — unit tests for tab working-set/reorder semantics and
 * workbench isolation. Active context selection is route-owned, so these tests
 * intentionally assert that the store only keeps open tab metadata.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useContextTabsStore } from "./context-tabs-store";

const PROJECT_A = "00000000-0000-4000-8000-aaaaaaaaaaaa";
const PROJECT_B = "00000000-0000-4000-8000-bbbbbbbbbbbb";

function tab(id: string, overrides: Partial<{ path: string; name: string }> = {}) {
  return {
    documentId: id,
    scheme: "kb" as const,
    path: overrides.path ?? `/notes/${id}.md`,
    name: overrides.name ?? `${id}.md`,
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
  };
}

describe("context-tabs-store", () => {
  beforeEach(() => {
    useContextTabsStore.setState({ byProject: {} });
  });

  it("openTab adds the tab without storing active selection", () => {
    useContextTabsStore.getState().openTab(PROJECT_A, tab("a"));
    const slice = useContextTabsStore.getState().byProject[PROJECT_A];
    expect(slice?.tabs.map((t) => t.documentId)).toEqual(["a"]);
    expect(slice).not.toHaveProperty("activeTabId");
  });

  it("openTab is idempotent on documentId and preserves tab order", () => {
    const { openTab } = useContextTabsStore.getState();
    openTab(PROJECT_A, tab("a"));
    openTab(PROJECT_A, tab("b"));
    openTab(PROJECT_A, tab("a"));
    const slice = useContextTabsStore.getState().byProject[PROJECT_A];
    expect(slice?.tabs.map((t) => t.documentId)).toEqual(["a", "b"]);
  });

  it("openTab refreshes name/path metadata on an existing tab", () => {
    const { openTab } = useContextTabsStore.getState();
    openTab(PROJECT_A, tab("a", { name: "old.md" }));
    openTab(PROJECT_A, tab("a", { name: "new.md", path: "/folder/new.md" }));
    const slice = useContextTabsStore.getState().byProject[PROJECT_A];
    expect(slice?.tabs[0]?.name).toBe("new.md");
    expect(slice?.tabs[0]?.path).toBe("/folder/new.md");
  });

  it("closeTab returns the right neighbour, then the left neighbour", () => {
    const { openTab, closeTab } = useContextTabsStore.getState();
    openTab(PROJECT_A, tab("a"));
    openTab(PROJECT_A, tab("b"));
    openTab(PROJECT_A, tab("c"));
    expect(closeTab(PROJECT_A, "b")?.documentId).toBe("c");
    expect(closeTab(PROJECT_A, "c")?.documentId).toBe("a");
    const slice = useContextTabsStore.getState().byProject[PROJECT_A];
    expect(slice?.tabs.map((t) => t.documentId)).toEqual(["a"]);
  });

  it("closeTab on the last tab returns null", () => {
    const { openTab, closeTab } = useContextTabsStore.getState();
    openTab(PROJECT_A, tab("a"));
    expect(closeTab(PROJECT_A, "a")).toBe(null);
  });

  it("closeTab on an unknown id is a no-op", () => {
    const { openTab, closeTab } = useContextTabsStore.getState();
    openTab(PROJECT_A, tab("a"));
    expect(closeTab(PROJECT_A, "ghost")).toBe(null);
    expect(useContextTabsStore.getState().byProject[PROJECT_A]?.tabs).toHaveLength(1);
  });

  it("reorderTabs moves a tab to a new index", () => {
    const { openTab, reorderTabs } = useContextTabsStore.getState();
    openTab(PROJECT_A, tab("a"));
    openTab(PROJECT_A, tab("b"));
    openTab(PROJECT_A, tab("c"));
    reorderTabs(PROJECT_A, 0, 2);
    const slice = useContextTabsStore.getState().byProject[PROJECT_A];
    expect(slice?.tabs.map((t) => t.documentId)).toEqual(["b", "c", "a"]);
  });

  it("workbench tab slices are independent", () => {
    const { openTab, closeTab } = useContextTabsStore.getState();
    openTab(PROJECT_A, tab("a"));
    openTab(PROJECT_B, tab("x"));
    closeTab(PROJECT_A, "a");
    expect(useContextTabsStore.getState().byProject[PROJECT_B]?.tabs).toHaveLength(1);
  });
});
