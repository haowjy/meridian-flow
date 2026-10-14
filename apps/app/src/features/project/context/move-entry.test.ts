/**
 * Move… and dragging refuse for the same reasons. A folder dropped inside its
 * own subtree would orphan it, and a taken name would be overwritten.
 */
import { expect, it } from "vitest";
import type { CatalogContextView, CatalogNode } from "@/client/query/context-catalog-projection";
import { type MoveDestination, type MoveSubject, moveRefusal } from "./move-entry";

const dir = (entryId: string, path: string, parentId: string): CatalogNode => ({
  kind: "dir",
  entryId,
  parentId,
  name: path.split("/").at(-1) ?? path,
  path,
  uri: `manuscript://${path}`,
});

function catalog(children: Record<string, CatalogNode[]>): CatalogContextView {
  return {
    root: {
      kind: "dir",
      entryId: "root",
      parentId: null,
      name: "",
      path: "",
      uri: "manuscript://",
    },
    children: (parentId: string) => children[parentId] ?? [],
  } as unknown as CatalogContextView;
}

const book = dir("book", "Book 1", "root");
const act = dir("act", "Book 1/Act 2", "book");
const notes = dir("notes", "Notes", "root");
const tree = catalog({
  root: [book, notes],
  book: [act],
  notes: [dir("dup", "Notes/Act 2", "notes")],
});

const folder = (node: CatalogNode, parentId: string): MoveSubject => ({
  kind: "folder",
  id: node.entryId,
  name: node.name,
  path: node.path,
  catalog: tree,
  parentId,
});
const into = (node: CatalogNode | null): MoveDestination => ({
  scheme: "manuscript",
  owner: {},
  catalog: tree,
  entryId: node?.entryId ?? "root",
  path: node?.path ?? "/",
});

it("refuses a folder into itself or its own subtree", () => {
  expect(moveRefusal(folder(book, "root"), into(book))?.kind).toBe("inside-itself");
  expect(moveRefusal(folder(book, "root"), into(act))?.kind).toBe("inside-itself");
  expect(moveRefusal(folder(act, "book"), into(notes))?.kind).toBe("name-taken");
  expect(moveRefusal(folder(notes, "root"), into(act))).toBeNull();
});

it("treats the current folder as already there, not as a refusal to explain", () => {
  expect(moveRefusal(folder(act, "book"), into(book))?.kind).toBe("already-there");
  expect(moveRefusal(folder(book, "root"), into(null))?.kind).toBe("already-there");
});
