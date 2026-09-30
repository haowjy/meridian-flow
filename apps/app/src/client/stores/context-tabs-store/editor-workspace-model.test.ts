/** Editor admission distinguishes authorable Scratch documents from Upload resources. */
import { expect, it } from "vitest";
import { type ContextTab, isEditorContextTab } from "./editor-workspace-model";

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
