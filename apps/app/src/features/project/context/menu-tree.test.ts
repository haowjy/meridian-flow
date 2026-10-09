import { describe, expect, it } from "vitest";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import { areaNode, buildMenuTree, foldersIn, type MenuArea } from "./menu-tree";

type Entry = { entryId: string; kind: "dir" | "file"; name: string; path: string; parent: string };

/** A catalog with just what the tree reads: children, ids, files and path lookup. */
function catalog(root: string, entries: Entry[]): CatalogContextView {
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  return {
    root: { entryId: root },
    normalized: { entries: byId },
    children: (parent: string) =>
      entries
        .filter((entry) => entry.parent === parent)
        .map((entry) => ({ ...entry, documentId: `doc-${entry.entryId}` })),
    files: () => entries.filter((entry) => entry.kind === "file"),
    findPath: (path: string) => entries.find((entry) => entry.path === path) ?? null,
  } as unknown as CatalogContextView;
}

const area = (id: string, name: string, extra: Partial<MenuArea> = {}): MenuArea => ({
  id,
  scheme: "manuscript",
  owner: {},
  name,
  icon: (() => null) as never,
  catalog: null,
  listed: true,
  ...extra,
});

const manuscript = area("area:manuscript", "Manuscript", {
  catalog: catalog("m", [
    { entryId: "act", kind: "dir", name: "Act", path: "/Act", parent: "m" },
    { entryId: "ch", kind: "file", name: "ch.md", path: "/Act/ch.md", parent: "act" },
  ]),
});
const uploads = area("area:document", "Uploads", { listed: false, scheme: "uploads" });

describe("a document menu's tree", () => {
  it("offers the listed areas at the root and keeps an unlisted one reachable", () => {
    const tree = buildMenuTree({
      heading: "My Serial",
      areas: [manuscript, uploads],
      rooted: true,
    });
    expect(tree.children(null).map((node) => node.name)).toEqual(["Manuscript"]);
    expect(tree.children("area:document")).toEqual([]);
  });

  it("climbs: the open document's trail is its area then its folders, and each step lists in place", () => {
    const tree = buildMenuTree({ heading: "My Serial", areas: [manuscript], rooted: true });
    const trail = [areaNode(manuscript), ...foldersIn(manuscript, "/Act/ch.md")];
    expect(trail.map((node) => node.id)).toEqual(["area:manuscript", "act"]);
    // Back rows pop the trail one level at a time; each level lists what is under it.
    expect(tree.children("act").map((node) => node.name)).toEqual(["ch.md"]);
    expect(tree.children("area:manuscript").map((node) => node.name)).toEqual(["Act"]);
    expect(tree.children(null).map((node) => node.id)).toEqual(["area:manuscript"]);
  });

  it("lists a single area's entries directly when not rooted", () => {
    const tree = buildMenuTree({ heading: "Scratch", areas: [manuscript], rooted: false });
    expect(tree.children(null).map((node) => node.name)).toEqual(["Act"]);
  });

  it("puts a rebound chat's earlier notes in one folder above the area's own", () => {
    const withEarlier = area("area:scratch", "Scratch", {
      scheme: "scratch",
      catalog: catalog("s", []),
      earlier: {
        rootThreadId: "root",
        catalog: catalog("e", [
          { entryId: "n", kind: "file", name: "n.md", path: "/n.md", parent: "e" },
        ]),
      },
    });
    const tree = buildMenuTree({ heading: "Scratch", areas: [withEarlier], rooted: false });
    expect(tree.children(null).map((node) => node.name)).toEqual(["Earlier notes"]);
    expect(tree.children("earlier:area:scratch").map((node) => node.name)).toEqual(["n.md"]);
  });
});
