/** Editor admission distinguishes authorable Scratch documents from Upload resources. */
import { expect, it } from "vitest";
import { type ContextTab, isEditorContextTab, isEditorTab } from "./editor-workspace-model";
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
    expect(parseEditorWorkspace({ project })).toBeUndefined();
  }
});

function lineageTab(): ContextTab {
  const { workId: _work, ...rest } = tab("scratch") as Extract<ContextTab, { kind: "tracked" }>;
  return { ...rest, rootThreadId: "root", rootThreadRef: "c12" };
}

function workspaceWith(tab: ContextTab) {
  return { project: { tabs: [{ ...tab, tabInstanceId: "tab" }], selectedTabIdByWork: {} } };
}

it("shows a chat's Scratch in every Editor, and a Work's Scratch only in its own", () => {
  expect(isEditorTab(lineageTab() as never, "any-work")).toBe(true);
  expect(isEditorTab(lineageTab() as never, null)).toBe(true);
  expect(isEditorTab(tab("scratch") as never, "work")).toBe(true);
  expect(isEditorTab(tab("scratch") as never, "other-work")).toBe(false);
});

it("restores a chat's Scratch tab only with its lineage and handle, and never with a Work", () => {
  expect(parseEditorWorkspace(workspaceWith(lineageTab()))).not.toBeUndefined();
  const noHandle = { ...lineageTab(), rootThreadRef: undefined } as ContextTab;
  const withWork = { ...lineageTab(), workId: "work" } as ContextTab;
  const notScratch = { ...tab("uploads"), workId: undefined, rootThreadId: "root" } as ContextTab;
  for (const invalid of [noHandle, withWork, notScratch])
    expect(parseEditorWorkspace(workspaceWith(invalid))).toBeUndefined();
});
