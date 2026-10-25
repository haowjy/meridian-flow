/**
 * A drop is planned from where the replica places each dragged row now, not
 * from what the drag recorded: rows are found by identity in any catalog, a
 * selection that spans systems moves nowhere, a folder carries what's inside
 * it, and a folder never lands inside itself.
 */
import type { ParentRef, ResourceLocation, ResourceRecord } from "@meridian/resource-replica";
import { expect, it } from "vitest";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import type { DragEntry, EntryRef } from "./entry";
import { type MoveArea, type MoveView, planMove } from "./move-plan";

const location = (
  scheme: ResourceLocation["scheme"],
  path: string,
  owner: { workId: string } | object = { workId: null },
) => ({ scheme, path, name: path.split("/").at(-1) ?? "", ...owner }) as ResourceLocation;
const root = (scheme: "manuscript" | "kb"): ParentRef => ({
  kind: "root",
  scheme,
  owner: { workId: null },
});

// Sources live in places no list shows: the replica knows them all.
const placed = {
  "file:ch1": {
    at: location("manuscript", "/Part/ch1"),
    parent: { kind: "folder", folderId: "part" },
  },
  "file:note": { at: location("scratch", "/note", { workId: "w1" }), parent: root("manuscript") },
  "folder:part": { at: location("manuscript", "/Part"), parent: root("manuscript") },
  "folder:act": {
    at: location("manuscript", "/Part/Act"),
    parent: { kind: "folder", folderId: "part" },
  },
} as Record<string, { at: ResourceLocation; parent: ParentRef }>;
const keyOf = (ref: EntryRef) => `${ref.kind}:${ref.id}`;
const record = (id: string, aliases: string[] = []) =>
  ({
    resource: {
      handle: `handle-${id}`,
      identity: { documentId: id },
      aliases: Object.fromEntries(
        aliases.map((alias) => [alias, { introducedAtIdentityRevision: 1 }]),
      ),
    },
  }) as ResourceRecord;

function catalog(rootId: string, folders: Record<string, string>): CatalogContextView {
  const dir = (id: string) => ({
    kind: "dir",
    entryId: id,
    name: folders[id],
    path: `/${folders[id]}`,
  });
  return {
    root: { entryId: rootId, uri: "manuscript://" },
    children: () => [],
    normalized: {
      entries: new Map(
        Object.keys(folders).map((id) => [
          id,
          { kind: "folder", sourceId: rootId, path: [folders[id]] },
        ]),
      ),
    },
    findPath: (path: string) =>
      Object.keys(folders)
        .map(dir)
        .find((d) => d.path === path) ?? null,
  } as unknown as CatalogContextView;
}

const area = (
  scheme: "manuscript" | "kb",
  rootId: string,
  folders: Record<string, string>,
): MoveArea => ({
  scheme,
  owner: { workId: null },
  catalog: catalog(rootId, folders),
  movable: true,
});

const view = (areas: MoveArea[]): MoveView => ({
  records: [record("ch1", ["local-ch1"]), record("note")],
  works: [],
  noWork: null,
  placement: {
    resourceLocation: (r: ResourceRecord) =>
      placed[`file:${r.resource.identity.documentId}`]?.at ?? null,
    parentForResource: (r: ResourceRecord) =>
      placed[`file:${r.resource.identity.documentId}`]?.parent ?? null,
    folderLocation: (id: string) => placed[`folder:${id}`]?.at ?? null,
    parentForFolder: (id: string) => placed[`folder:${id}`]?.parent ?? null,
  } as MoveView["placement"],
  areas,
});

const drag = (...refs: EntryRef[]): DragEntry[] =>
  refs.map((ref) => ({ ref, name: keyOf(ref), uri: "", movable: true }));
const file = (id: string): EntryRef => ({ kind: "file", id });
const folder = (id: string): EntryRef => ({ kind: "folder", id });
const into = (rootId: string, scheme: "manuscript" | "kb", entryId: string, name: string) => ({
  scheme,
  catalogRootId: rootId,
  folder: { entryId, path: `/${name}`, uri: `${scheme}://${name}/`, name },
});

it("finds a dragged row by identity in a catalog the destination list doesn't show", () => {
  const plan = planMove(
    view([area("kb", "kb-root", { characters: "characters" })]),
    drag(file("local-ch1")),
    into("kb-root", "kb", "characters", "characters"),
  );
  expect(plan).toMatchObject({
    kind: "ready",
    moves: [
      {
        entry: file("local-ch1"),
        name: "ch1",
        before: { kind: "folder", folderId: "part" },
        after: { kind: "folder", folderId: "characters" },
      },
    ],
  });
});

it("moves nowhere when the dragged rows span systems", () => {
  const plan = planMove(
    view([area("kb", "kb-root", { characters: "characters" })]),
    drag(file("ch1"), file("note")),
    into("kb-root", "kb", "characters", "characters"),
  );
  expect(plan.kind).toBe("none");
});

it("carries a folder's contents with it and refuses it inside itself", () => {
  const manuscript = view([area("manuscript", "m-root", { part: "Part", act: "Act" })]);
  const carried = planMove(manuscript, drag(folder("part"), file("ch1"), folder("act")), {
    scheme: "manuscript",
    catalogRootId: "m-root",
    folder: null,
  });
  // Everything rode along with Part, which already sits at the top level.
  expect(carried.kind).toBe("none");
  expect(
    planMove(manuscript, drag(folder("part")), into("m-root", "manuscript", "act", "Act")),
  ).toEqual({ kind: "inside-itself" });
});
