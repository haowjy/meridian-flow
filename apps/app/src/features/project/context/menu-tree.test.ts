/**
 * Menu tree behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - project menu drill-in algorithm
 */
import { describe, expect, it } from "vitest";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import {
  buildMenuTree,
  crumbTrailFor,
  type MenuArea,
  menuEntryFor,
  pathSegments,
  trailAlong,
} from "./menu-tree";

type Entry = { entryId: string; kind: "dir" | "file"; name: string; path: string; parent: string };

/** A catalog with just what the tree reads: children, ids, files and path lookup. */
function catalog(root: string, entries: Entry[]): CatalogContextView {
  const byId = new Map(
    entries.map((entry) => [
      entry.entryId,
      {
        observationVersion: "1",
        ...entry,
        kind: entry.kind === "dir" ? "folder" : "file",
        path: entry.path.split("/").filter(Boolean),
        sourceId: root,
      },
    ]),
  );
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
const uploads = area("area:document", "Uploads", {
  listed: false,
  scheme: "uploads",
  catalog: catalog("u", [
    { entryId: "map", kind: "file", name: "map.png", path: "/map.png", parent: "u" },
  ]),
});

describe("a document menu's tree", () => {
  it("offers the listed areas at the root and keeps an unlisted one reachable", () => {
    const tree = buildMenuTree({
      heading: "My Serial",
      areas: [manuscript, uploads],
    });
    expect(tree.children(null).map((node) => node.name)).toEqual(["Manuscript"]);
    // The open document's own area is held but not offered: it lists its files when asked.
    expect(tree.children("area:document").map((node) => node.name)).toEqual(["map.png"]);
  });

  it("climbs: the open document's trail is its area then its folders, and each step lists in place", () => {
    const tree = buildMenuTree({ heading: "My Serial", areas: [manuscript] });
    const trail = trailAlong(manuscript, pathSegments("/Act/ch.md").slice(0, -1));
    expect(trail.map((node) => node.id)).toEqual(["area:manuscript", "act"]);
    // Back rows pop the trail one level at a time; each level lists what is under it.
    expect(tree.children("act").map((node) => node.name)).toEqual(["ch.md"]);
    expect(tree.children("area:manuscript").map((node) => node.name)).toEqual(["Act"]);
    expect(tree.children(null).map((node) => node.id)).toEqual(["area:manuscript"]);
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
    const tree = buildMenuTree({ heading: "Scratch", areas: [withEarlier] });
    expect(tree.children("area:scratch").map((node) => node.name)).toEqual(["Earlier notes"]);
    expect(tree.children("earlier:area:scratch").map((node) => node.name)).toEqual(["n.md"]);
  });
});

describe("folder picker boundaries", () => {
  it("does not confuse equal paths across areas in one shared catalog snapshot", () => {
    const m = catalog("m", [
      { entryId: "m-act", kind: "dir", name: "Act", path: "/Act", parent: "m" },
    ]);
    const k = catalog("k", [
      { entryId: "k-act", kind: "dir", name: "Act", path: "/Act", parent: "k" },
      { entryId: "note", kind: "file", name: "note.md", path: "/Act/note.md", parent: "k-act" },
    ]);
    const entries = new Map([...m.normalized.entries, ...k.normalized.entries]);
    m.normalized = { ...m.normalized, entries };
    k.normalized = { ...k.normalized, entries };
    const tree = buildMenuTree({
      heading: "",
      areas: [
        area("m", "Manuscript", { catalog: m }),
        area("k", "Knowledge Base", { scheme: "kb", catalog: k }),
      ],
    });
    expect(menuEntryFor(m, "k-act")).toBeNull();
    expect(menuEntryFor(k, "k-act")?.entryId).toBe("k-act");
    expect(tree.children("k-act").map((node) => node.name)).toEqual(["note.md"]);
  });
});

describe("crumb opening trails", () => {
  const nested = area("area:manuscript", "Manuscript", {
    catalog: catalog("m", [
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
