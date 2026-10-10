/** Refused namespace work retains its destination without offering name-only move repair. */
import type { ResourceDestination, ResourceLocation } from "@meridian/resource-replica";
import { describe, expect, it } from "vitest";
import { refusedMoveDestination } from "./context-catalog-projection";

const current: ResourceLocation = {
  scheme: "manuscript",
  path: "/Act 1/chapter.md",
  name: "chapter.md",
  workId: null,
};
const rename: ResourceDestination = {
  scheme: "manuscript",
  folderPath: "/Act 1",
  name: "revised.md",
  workId: null,
};

describe("refused namespace repair", () => {
  it("keeps name-only and normalized same-parent refusals on the rename path", () => {
    expect(refusedMoveDestination(undefined, current)).toBeUndefined();
    expect(refusedMoveDestination(rename, current)).toBeUndefined();
    expect(refusedMoveDestination({ ...rename, folderPath: "Act 1/" }, current)).toBeUndefined();
    expect(
      refusedMoveDestination({ ...rename, folderPath: "" }, { ...current, path: "/chapter.md" }),
    ).toBeUndefined();
  });

  it.each([
    { ...rename, folderPath: "/Research" },
    { ...rename, scheme: "kb" as const },
    { ...rename, folderPath: "" },
  ])("retains a refused folder or area move's complete destination", (destination) => {
    expect(refusedMoveDestination(destination, current)).toEqual(destination);
  });

  it("compares the actual Scratch owner, not the selected Work", () => {
    const scratch: ResourceLocation = {
      ...current,
      scheme: "scratch",
      workId: "work",
      workSlug: "notes",
    };
    const otherWork: ResourceDestination = {
      ...rename,
      scheme: "scratch",
      workId: "other",
      workSlug: "other",
    };
    expect(refusedMoveDestination(otherWork, scratch)).toEqual(otherWork);
    const lineage: ResourceLocation = {
      ...current,
      scheme: "scratch",
      rootThreadId: "lineage",
      rootThreadRef: "c1",
    };
    const otherLineage: ResourceDestination = {
      ...rename,
      scheme: "scratch",
      rootThreadId: "other",
      rootThreadRef: "c2",
    };
    expect(refusedMoveDestination(otherLineage, lineage)).toEqual(otherLineage);
    expect(
      refusedMoveDestination(
        { ...otherLineage, rootThreadId: "lineage", rootThreadRef: "c1" },
        lineage,
      ),
    ).toBeUndefined();
  });
});
