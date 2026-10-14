/**
 * Undo is judged against the replica as it is when pressed: a row still where
 * the drop put it goes back under its current name, one that moved again since
 * (or is gone) stays. A placement the replica refuses is reported without
 * losing the rows that did move, and Undo still covers those.
 */
import type { ParentRef, ResourceLocation } from "@meridian/resource-replica";
import { expect, it } from "vitest";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { executeMove } from "./execute-move";
import { type MoveEffect, type PlacementView, planUndo } from "./move-plan";

const folder = (folderId: string): ParentRef => ({ kind: "folder", folderId });
const effect = (id: string): MoveEffect => ({
  entry: { kind: "folder", id },
  name: id,
  before: folder("book"),
  after: folder("act"),
});

it("returns only rows still where the drop put them, under their current names", () => {
  const now: Record<string, { name: string; parent: ParentRef }> = {
    a: { name: "renamed", parent: folder("act") },
    b: { name: "b", parent: folder("elsewhere") },
  };
  const view = {
    records: [],
    placement: {
      folderLocation: (id: string) => (now[id] ? { name: now[id].name } : null),
      parentForFolder: (id: string) => now[id]?.parent ?? null,
    },
  } as unknown as PlacementView;
  expect(planUndo(view, [effect("a"), effect("b"), effect("gone")])).toEqual([
    { entry: effect("a").entry, name: "renamed", before: folder("act"), after: folder("book") },
  ]);
});

it("reports a refused row and keeps the rest to undo", async () => {
  const resources = {
    observeProjection: () => () => {},
    setFolderLocation: async (_project: string, id: string) => {
      if (id === "b") throw new Error("refused");
      return { operationId: null };
    },
  } as unknown as AccountResourceReplica;
  const catalog = { root: { entryId: "root" } } as CatalogContextView;
  const result = await executeMove(
    {
      kind: "ready",
      destination: { scheme: "manuscript", owner: {}, catalog, entryId: "act", path: "/Act" },
      destinationName: "Act",
      moves: ["a", "b"].map((id) => ({
        ref: { kind: "folder", id },
        name: id,
        parent: folder("book"),
        location: {} as ResourceLocation,
      })),
    },
    folder("act"),
    { resources, projectId: "p" },
  );
  expect(result.moved.map((moved) => moved.entry.id)).toEqual(["a"]);
  expect(result.moved[0]).toMatchObject({ before: folder("book"), after: folder("act") });
  expect(result.failed).toEqual([{ entry: { kind: "folder", id: "b" }, name: "b" }]);
});
