/**
 * A placement the replica refuses is reported without losing the rows that did move, and rows
 * arriving under one name take distinct free names.
 */
import type { CatalogEntry } from "@meridian/contracts/protocol";
import type { ParentRef } from "@meridian/resource-replica";
import { expect, it } from "vitest";
import type { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { moveRows, type NamingView } from "./execute-move";

const folder = (folderId: string): ParentRef => ({ kind: "folder", folderId });
const holding = (names: string[]): NamingView => ({
  records: [],
  placement: {
    childrenAt: () =>
      names.map((name) => ({ kind: "folder", entryId: `held-${name}`, name }) as CatalogEntry),
  },
});

it("reports a refused row and keeps the rows that moved", async () => {
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
      row: null,
      name: id,
      before: folder("book"),
      after: folder("act"),
    })),
    { resources, projectId: "p" },
    holding([]),
  );
  expect(result.moved).toEqual([{ kind: "folder", id: "a" }]);
  expect(result.failed).toEqual([{ entry: { kind: "folder", id: "b" }, name: "b" }]);
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
  await moveRows(
    ["a", "b"].map((id) => ({
      entry: { kind: "folder", id },
      row: null,
      name: "Notes",
      before: folder(id),
      after: folder("act"),
    })),
    { resources, projectId: "p" },
    holding(["Notes"]),
  );
  expect(placed).toEqual(["Notes (2)", "Notes (3)"]);
});
