/**
 * Menu tree behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - project menu drill-in algorithm
 */
import { describe, expect, it } from "vitest";
import type { TreeView } from "@/core/project-tree/tree-view";
import { buildMenuTree, crumbTrailFor, type MenuArea, menuEntryFor } from "./menu-tree";

type Entry = { entryId: string; kind: "dir" | "file"; name: string; path: string; parent: string };

/** A tree with just what the menu reads: children, ids, files and path lookup. */
function tree(root: string, entries: Entry[]): TreeView {
  const shown = entries.map((entry) => ({ ...entry, documentId: `doc-${entry.entryId}` }));
  return {
    root: { entryId: root },
    entry: (id: string) => shown.find((entry) => entry.entryId === id) ?? null,
    children: (parent: string) => shown.filter((entry) => entry.parent === parent),
    files: () => shown.filter((entry) => entry.kind === "file"),
    findPath: (path: string) => shown.find((entry) => entry.path === path) ?? null,
  } as unknown as TreeView;
}

const area = (id: string, name: string, extra: Partial<MenuArea> = {}): MenuArea => ({
  id,
  scheme: "manuscript",
  owner: {},
  name,
  icon: (() => null) as never,
  tree: null,
  listed: true,
  ...extra,
});

const manuscript = area("area:manuscript", "Manuscript", {
  tree: tree("m", [
    { entryId: "act", kind: "dir", name: "Act", path: "/Act", parent: "m" },
    { entryId: "ch", kind: "file", name: "ch.md", path: "/Act/ch.md", parent: "act" },
  ]),
});
describe("a document menu's tree", () => {
  it("puts a rebound chat's earlier notes in one folder above the area's own", () => {
    const withEarlier = area("area:scratch", "Scratch", {
      scheme: "scratch",
      tree: tree("s", []),
      earlier: {
        rootThreadId: "root",
        tree: tree("e", [{ entryId: "n", kind: "file", name: "n.md", path: "/n.md", parent: "e" }]),
      },
    });
    const menu = buildMenuTree({ heading: "Scratch", areas: [withEarlier] });
    expect(menu.children("area:scratch").map((node) => node.name)).toEqual(["Earlier notes"]);
    expect(menu.children("earlier:area:scratch").map((node) => node.name)).toEqual(["n.md"]);
  });
});

describe("folder picker boundaries", () => {
  it("does not confuse equal paths across areas", () => {
    const m = tree("m", [
      { entryId: "m-act", kind: "dir", name: "Act", path: "/Act", parent: "m" },
    ]);
    const k = tree("k", [
      { entryId: "k-act", kind: "dir", name: "Act", path: "/Act", parent: "k" },
      { entryId: "note", kind: "file", name: "note.md", path: "/Act/note.md", parent: "k-act" },
    ]);
    const menu = buildMenuTree({
      heading: "",
      areas: [
        area("m", "Manuscript", { tree: m }),
        area("k", "Knowledge Base", { scheme: "kb", tree: k }),
      ],
    });
    expect(menuEntryFor(m, "k-act")).toBeNull();
    expect(menuEntryFor(k, "k-act")?.entryId).toBe("k-act");
    expect(menu.children("k-act").map((node) => node.name)).toEqual(["note.md"]);
  });
});

describe("crumb opening trails", () => {
  const nested = area("area:manuscript", "Manuscript", {
    tree: tree("m", [
      { entryId: "book", kind: "dir", name: "Book", path: "/Book", parent: "m" },
      { entryId: "part", kind: "dir", name: "Part", path: "/Book/Part", parent: "book" },
      { entryId: "act", kind: "dir", name: "Act", path: "/Book/Part/Act", parent: "part" },
      { entryId: "ch", kind: "file", name: "ch.md", path: "/Book/Part/Act/ch.md", parent: "act" },
    ]),
  });
  const path = "/Book/Part/Act/ch.md";
  const ids = (source: MenuArea, depth: number) =>
    crumbTrailFor(source, path, depth).map((n) => n.id);

  it("opens a listed area among areas and an unlisted area inside itself", () => {
    expect(ids(nested, 0)).toEqual([]);
    expect(ids({ ...nested, listed: false, scheme: "uploads" }, 0)).toEqual(["area:manuscript"]);
    expect(ids({ ...nested, listed: false, scheme: "scratch" }, 0)).toEqual(["area:manuscript"]);
    expect(crumbTrailFor(null, path, 0)).toEqual([]);
  });

  it("opens every folder in its parent and the filename in its folder", () => {
    expect(ids(nested, 1)).toEqual(["area:manuscript"]);
    expect(ids(nested, 2)).toEqual(["area:manuscript", "book"]);
    expect(ids(nested, 3)).toEqual(["area:manuscript", "book", "part"]);
    expect(ids(nested, 4)).toEqual(["area:manuscript", "book", "part", "act"]);
    expect(crumbTrailFor(manuscript, "/root.md", 1).map((n) => n.id)).toEqual(["area:manuscript"]);
  });
});
