/** History pointers admit only the exact account/project/Work-owned local draft. */
import { describe, expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { resolveLocalDocumentSelection, selectEditorEntryTab } from "./project-local-selection";

const tab: ContextTab = { kind: "new", documentId: "draft-a", name: "Untitled", workId: "work" };
const input = {
  accountId: "account",
  projectId: "project",
  workId: "work",
  hydrated: true,
  tabs: [tab],
  pointer: { version: 1, accountId: "account", projectId: "project", documentId: "draft-a" },
};
describe("local document history", () => {
  it("waits for hydration and then selects exactly the recorded draft", () => {
    expect(resolveLocalDocumentSelection({ ...input, hydrated: false }).kind).toBe("loading");
    expect(resolveLocalDocumentSelection(input)).toMatchObject({
      kind: "resolved",
      documentId: "draft-a",
    });
  });
  it("keeps absent distinct from stale, foreign, malformed, or wrong-Work pointers", () => {
    expect(resolveLocalDocumentSelection({ ...input, pointer: undefined }).kind).toBe("absent");
    for (const change of [
      { tabs: [] },
      { accountId: "other" },
      { projectId: "other" },
      { workId: "other" },
      { pointer: null },
      { pointer: { ...input.pointer, version: 2 } },
    ])
      expect(resolveLocalDocumentSelection({ ...input, ...change }).kind).toBe("unavailable");
  });
});

describe("Editor screen entry", () => {
  const document: ContextTab = {
    kind: "tracked",
    documentId: "doc",
    name: "Renamed.md",
    scheme: "manuscript",
    path: "/Renamed.md",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
  const entry = {
    tabs: [tab, document],
    workId: "work",
    selectedDocumentId: undefined,
    recentRoutes: [],
  };
  it("chooses the selected open tab without requiring recent history", () => {
    expect(selectEditorEntryTab({ ...entry, selectedDocumentId: tab.documentId })).toBe(tab);
  });
  it("uses the current tab location, not a remembered path", () => {
    expect(
      selectEditorEntryTab({
        ...entry,
        recentRoutes: [{ documentId: "doc", scheme: "manuscript", path: "/Old.md" }],
      }),
    ).toBe(document);
  });
  it("does not reopen closed identities or choose an arbitrary open tab", () => {
    expect(selectEditorEntryTab(entry)).toBeNull();
    expect(
      selectEditorEntryTab({
        ...entry,
        tabs: [],
        selectedDocumentId: "doc",
        recentRoutes: [{ documentId: "doc", scheme: "manuscript", path: "/Old.md" }],
      }),
    ).toBeNull();
    expect(
      selectEditorEntryTab({ ...entry, workId: "other", selectedDocumentId: tab.documentId }),
    ).toBeNull();
  });
});
