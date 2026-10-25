/**
 * Undo is judged against the replica as it is when pressed: a row still where
 * the drop put it, under its arrival name, goes back; one renamed or moved
 * again since (or gone) stays. A placement the replica refuses is reported without
 * losing the rows that did move, and Undo still covers those.
 */
import type { CatalogEntry } from "@meridian/contracts/protocol";
import type { ParentRef, ResourceRecord } from "@meridian/resource-replica";
import { expect, it } from "vitest";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { moveRows, type NamingView } from "./execute-move";
import { type MoveEffect, type PlacementView, planUndo } from "./move-plan";

const folder = (folderId: string): ParentRef => ({ kind: "folder", folderId });
const holding = (names: string[]): NamingView => ({
  records: [],
  placement: {
    childrenAt: () =>
      names.map((name) => ({ kind: "folder", entryId: `held-${name}`, name }) as CatalogEntry),
  },
});
const effect = (id: string): MoveEffect => ({
  entry: { kind: "folder", id },
  name: id,
  previousName: `${id}-before`,
  before: folder("book"),
  after: folder("act"),
  previousPosition: {},
  action: "move",
});

it("returns only rows still where and as the drop left them", () => {
  const now: Record<string, { name: string; parent: ParentRef }> = {
    a: { name: "a", parent: folder("act") },
    b: { name: "b", parent: folder("elsewhere") },
    c: { name: "renamed", parent: folder("act") },
  };
  const reminted = {
    resource: {
      handle: "created-handle",
      identity: { documentId: "server-id" },
      aliases: { "local-id": { introducedAtIdentityRevision: 1 } },
    },
  } as unknown as ResourceRecord;
  const remintedEffect: MoveEffect = {
    entry: { kind: "file", id: "local-id" },
    name: "created",
    previousName: "created-before",
    before: folder("book"),
    after: folder("act"),
    previousPosition: {},
    action: "move",
  };
  const view = {
    records: [reminted],
    placement: {
      folderLocation: (id: string) => (now[id] ? { name: now[id].name } : null),
      parentForFolder: (id: string) => now[id]?.parent ?? null,
      resourceLocation: (record: ResourceRecord) =>
        record === reminted ? { name: "created" } : null,
      parentForResource: (record: ResourceRecord) => (record === reminted ? folder("act") : null),
      childrenAt: () => [],
    },
  } as unknown as PlacementView;
  expect(
    planUndo(view, [effect("a"), effect("b"), effect("c"), effect("gone"), remintedEffect]),
  ).toEqual([
    {
      entry: effect("a").entry,
      name: "a-before",
      before: folder("act"),
      after: folder("book"),
      position: { kind: "end" },
    },
    {
      entry: remintedEffect.entry,
      name: "created-before",
      before: folder("act"),
      after: folder("book"),
      position: { kind: "end" },
    },
  ]);

  const carried = [
    { ...effect("a"), previousPosition: { beforeId: "b" } },
    { ...effect("b"), previousPosition: { afterId: "a", beforeId: "c" } },
    { ...effect("c"), previousPosition: { afterId: "b" } },
  ];
  const carriedView = {
    ...view,
    placement: {
      ...view.placement,
      folderLocation: (id: string) => ({ name: id }),
      parentForFolder: () => folder("act"),
      childrenAt: () =>
        ["c", "a", "b"].map((id) => ({ kind: "folder", entryId: id, name: id }) as CatalogEntry),
    },
  } as unknown as PlacementView;
  expect(planUndo(carriedView, carried).map((row) => row.position)).toEqual([
    { kind: "start" },
    { kind: "after", siblingId: "a" },
    { kind: "after", siblingId: "b" },
  ]);

  const rankIntent = {
    handle: "a",
    projectId: "p",
    intentId: "intent",
    operationId: "operation",
    sequence: 1,
    identityRevision: 1,
    desired: {
      kind: "set-folder-location" as const,
      typedName: "a",
      destination: { parent: folder("act"), name: "a", position: { kind: "start" as const } },
    },
    attempts: [
      {
        attemptId: "attempt",
        request: {} as never,
        outcome: {
          kind: "operation" as const,
          receipt: {
            operationId: "operation",
            observationVersion: "10",
            command: {} as never,
            result: {
              ok: true as const,
              value: { destinationPath: "Act/a", locationVersion: "4" },
            },
          },
        },
      },
    ],
    state: "settled" as const,
  };
  const rankedView = {
    ...view,
    folders: [
      {
        folderId: "a",
        canonicalLocationVersion: "4",
        observationVersion: "11",
        intents: [rankIntent],
      },
    ],
  } as unknown as PlacementView;
  const rankedEffect = {
    ...effect("a"),
    operationId: "operation",
    position: { kind: "start" as const },
  };
  expect(planUndo(rankedView, [rankedEffect])).toHaveLength(1);
  const peerRankedView = {
    ...rankedView,
    folders: [{ ...rankedView.folders?.[0], canonicalLocationVersion: "5" }],
  } as PlacementView;
  expect(planUndo(peerRankedView, [rankedEffect])).toEqual([]);
});

it("reports a refused row and keeps the rest to undo", async () => {
  const resources = {
    observeProjection: () => () => {},
    setFolderLocation: async (_project: string, id: string) => {
      if (id === "b") throw new Error("refused");
      return { operationId: null };
    },
  } as unknown as AccountResourceReplica;
  const result = await moveRows(
    ["a", "b"].map((id) => ({
      entry: { kind: "folder", id },
      name: id,
      before: folder("book"),
      after: folder("act"),
    })),
    { resources, projectId: "p" },
    holding([]),
  );
  expect(result.moved.map((moved) => moved.entry.id)).toEqual(["a"]);
  expect(result.moved[0]).toMatchObject({ before: folder("book"), after: folder("act") });
  expect(result.failed).toEqual([
    { entry: { kind: "folder", id: "b" }, name: "b", action: "move" },
  ]);
});

it("gives rows arriving under one name in the same drop distinct free names", async () => {
  const placed: string[] = [];
  const resources = {
    observeProjection: () => () => {},
    setFolderLocation: async (_project: string, _id: string, location: { name: string }) => {
      placed.push(location.name);
      return { operationId: null };
    },
  } as unknown as AccountResourceReplica;
  const result = await moveRows(
    ["a", "b"].map((id) => ({
      entry: { kind: "folder", id },
      name: "Notes",
      before: folder(id),
      after: folder("act"),
    })),
    { resources, projectId: "p" },
    holding(["Notes"]),
  );
  expect(placed).toEqual(["Notes (2)", "Notes (3)"]);
  expect(result.moved.map((moved) => moved.name)).toEqual(["Notes (2)", "Notes (3)"]);
});
