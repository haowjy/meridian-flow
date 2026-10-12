/** Refused commands retain parent identity, separating rename from move repair. */
import type { ParentRef, ResourceDestination } from "@meridian/resource-replica";
import { expect, it } from "vitest";
import { refusedMoveDestination } from "./context-catalog-projection";

const parent: ParentRef = { kind: "folder", folderId: "act-one" };
const rename: ResourceDestination = { parent, name: "revised.md" };
it("keeps name-only refusals on the rename path regardless of ancestor paths", () => {
  expect(refusedMoveDestination(undefined, parent)).toBeUndefined();
  expect(refusedMoveDestination(rename, { ...parent })).toBeUndefined();
});
it.each<ParentRef>([
  { kind: "folder", folderId: "research" },
  { kind: "root", scheme: "kb", owner: { workId: null } },
  { kind: "root", scheme: "manuscript", owner: { workId: null } },
])("retains a refused folder or area move's destination", (target) => {
  const destination = { parent: target, name: rename.name };
  expect(refusedMoveDestination(destination, parent)).toEqual(destination);
});
it("compares the actual Scratch owner, not the selected Work", () => {
  const work: ParentRef = {
    kind: "root",
    scheme: "scratch",
    owner: { workId: "work", workSlug: "notes" },
  };
  const other: ResourceDestination = {
    parent: { kind: "root", scheme: "scratch", owner: { workId: "other", workSlug: "other" } },
    name: "note.md",
  };
  expect(refusedMoveDestination(other, work)).toEqual(other);
  const lineage: ParentRef = {
    kind: "root",
    scheme: "scratch",
    owner: { workId: null, rootThreadId: "lineage", rootThreadRef: "c1" },
  };
  const different: ResourceDestination = {
    parent: {
      kind: "root",
      scheme: "scratch",
      owner: { workId: null, rootThreadId: "other", rootThreadRef: "c2" },
    },
    name: "note.md",
  };
  expect(refusedMoveDestination(different, lineage)).toEqual(different);
  expect(refusedMoveDestination({ ...different, parent: lineage }, lineage)).toBeUndefined();
});
