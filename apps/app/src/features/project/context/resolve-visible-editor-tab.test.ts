/** The pane and rail hand-off consume the same route props and identity binding. */
import { expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { resolveVisibleEditorTab } from "./resolve-visible-editor-tab";

const moved: ContextTab = {
  kind: "tracked",
  documentId: "document",
  resourceHandle: "resource",
  origin: "local-resource",
  scheme: "manuscript",
  path: "/moved.md",
  name: "moved.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

it("uses the published materialized-local locator rather than an Untitled fallback", () => {
  const visible = resolveVisibleEditorTab({
    tabs: [moved],
    localDocumentId: "document",
    selectedTabId: "old-selection",
    editorWorkId: "work",
    activeContextScheme: "manuscript",
    activeContextPath: "/moved.md",
    selection: { status: "none", revision: 0 },
  });
  expect(visible.tab).toBe(moved);
  expect(visible.workspaceRoute.kind).toBe("owner");
});

it("shows the bound document after a rename, before its readable address follows", () => {
  const reused = { ...moved, documentId: "other", path: "/old.md", name: "old.md" };
  const visible = resolveVisibleEditorTab({
    tabs: [reused, moved],
    selectedTabId: "other",
    editorWorkId: "work",
    activeContextScheme: "manuscript",
    activeContextPath: "/old.md",
    selection: {
      status: "bound",
      revision: 1,
      locator: { scheme: "manuscript", path: "/old.md", workId: "work" },
      identity: { kind: "server", documentId: "document" },
    },
  });
  expect(visible.tab).toBe(moved);
});

it("does not carry a retained selection from the Editor chooser", () => {
  expect(
    resolveVisibleEditorTab({
      tabs: [moved],
      selectedTabId: "document",
      editorWorkId: "work",
      activeContextScheme: null,
      activeContextPath: null,
      selection: { status: "none", revision: 0 },
    }).tab,
  ).toBeNull();
});

it("lets the local history pointer select its Untitled tab before persisted selection", () => {
  const untitled: ContextTab = {
    kind: "new",
    documentId: "untitled",
    resourceHandle: "local",
    name: "Untitled",
  };
  expect(
    resolveVisibleEditorTab({
      tabs: [moved, untitled],
      selectedTabId: "document",
      localDocumentId: "untitled",
      editorWorkId: "work",
      activeContextScheme: "unfiled",
      activeContextPath: "",
      selection: { status: "none", revision: 0 },
    }).tab,
  ).toBe(untitled);
});
