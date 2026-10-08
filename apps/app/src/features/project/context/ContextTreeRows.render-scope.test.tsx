// @vitest-environment jsdom

/** A large tree re-renders only the rows whose own state changed when the selection or catalog moves. */
import { act, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type {
  CatalogContextView,
  CatalogDirectory,
  CatalogFile,
  CatalogNode,
} from "@/client/query/context-catalog-projection";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { type TreeActions, TreeChildren, TreeEnvProvider } from "./ContextTreeRows";

const rowRenders = new Map<string, number>();

// Every row renders exactly one note, so its renders count the row's renders.
vi.mock("./LinkUpdateNote", () => ({
  LinkUpdateNote: ({ subject }: { subject: { id: string } }) => {
    rowRenders.set(subject.id, (rowRenders.get(subject.id) ?? 0) + 1);
    return null;
  },
}));

beforeEach(() => rowRenders.clear());

const FILES = 300;

function file(index: number): CatalogFile {
  return {
    kind: "file",
    entryId: `entry-${index}`,
    parentId: "dir-chapters",
    documentId: `doc-${index}`,
    name: `chapter-${index}.md`,
    path: `/chapters/chapter-${index}.md`,
    uri: `manuscript:///chapters/chapter-${index}.md`,
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  };
}

/** A fresh projection each call, as a resource update produces: equal fields, new objects. */
function catalog(): CatalogContextView {
  const root: CatalogDirectory = {
    kind: "dir",
    entryId: "root",
    parentId: null,
    name: "",
    path: "",
    uri: "manuscript:///",
  };
  const chapters: CatalogDirectory = {
    kind: "dir",
    entryId: "dir-chapters",
    parentId: "root",
    name: "chapters",
    path: "/chapters",
    uri: "manuscript:///chapters",
  };
  const files = Array.from({ length: FILES }, (_, index) => file(index));
  return {
    root,
    children: (parentId: string): readonly CatalogNode[] =>
      parentId === "root" ? [chapters] : parentId === "dir-chapters" ? files : [],
    findPath: () => null,
  } as unknown as CatalogContextView;
}

const actions: TreeActions = {
  projectId: "project",
  workId: null,
  scheme: "manuscript",
  onSelectFile: () => undefined,
  onRequestCreate: () => undefined,
  onRequestDelete: () => undefined,
  onCreateDone: () => undefined,
  onCreatedFilePath: () => undefined,
  toggleEntry: () => undefined,
};

let setActivePath: (path: string | null) => void = () => undefined;
let refreshCatalog: () => void = () => undefined;

function Tree() {
  const [activePath, setPath] = useState<string | null>("/chapters/chapter-1.md");
  const [view, setView] = useState(catalog);
  setActivePath = setPath;
  refreshCatalog = () => setView(catalog());
  return (
    <TreeEnvProvider
      actions={actions}
      view={{ activePath, creating: null, isExpanded: () => true, catalog: view }}
    >
      <TreeChildren parentId="root" parentPath="" depth={1} />
    </TreeEnvProvider>
  );
}

it("re-renders only the previously and newly active rows when the selection moves", async () => {
  await withReactRoot(<Tree />, async () => {
    expect(rowRenders.size).toBe(FILES + 1);
    rowRenders.clear();
    await act(async () => setActivePath("/chapters/chapter-200.md"));
    expect([...rowRenders.keys()].sort()).toEqual(["doc-1", "doc-200"]);
  });
});

it("re-renders no row when a catalog refresh rebuilds equal nodes", async () => {
  await withReactRoot(<Tree />, async () => {
    rowRenders.clear();
    await act(async () => refreshCatalog());
    expect(rowRenders.size).toBe(0);
  });
});
