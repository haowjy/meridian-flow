/** Editor admission distinguishes authorable Scratch documents from Upload resources. */
import { expect, it } from "vitest";
import { type ContextTab, isEditorContextTab } from "./editor-workspace-model";
import { parseEditorWorkspace } from "./editor-workspace-state";

function tab(scheme: "scratch" | "uploads"): ContextTab {
  return {
    kind: "tracked",
    documentId: `document-${scheme}`,
    scheme,
    path: "/note.md",
    name: "note.md",
    workId: "work",
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

it("admits Scratch documents but keeps Upload resources out of the Editor", () => {
  expect(isEditorContextTab(tab("scratch"))).toBe(true);
  expect(isEditorContextTab(tab("uploads"))).toBe(false);
});

it("drops old No Work snapshots with empty selection keys or ownerless Scratch tabs", () => {
  const scratch = { ...tab("scratch"), tabInstanceId: "tab" };
  for (const project of [
    { tabs: [scratch], selectedTabIdByWork: { "": scratch.documentId } },
    { tabs: [{ ...scratch, workId: undefined }], selectedTabIdByWork: {} },
  ]) {
    expect(
      parseEditorWorkspace(
        JSON.stringify({ version: 1, accountId: "account", projects: { project } }),
      ),
    ).toBeNull();
  }
});
