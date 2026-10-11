/** Retained moves resolve by authority and full folder path, never by basename. */
import { Folder } from "lucide-react";
import { expect, it } from "vitest";
import type { DrillNode } from "@/components/app/DrillInMenu";
import { moveRepairTrail } from "./move-repair-trail";
import type { ProjectMenuSource } from "./use-catalog-menu-source";

const node = (id: string): DrillNode => ({ id, name: "Notes", folder: true, icon: Folder });
function source(): Pick<ProjectMenuSource, "tree" | "folderFor"> {
  const folders = {
    work: { scheme: "scratch", owner: { workId: "work" }, path: "/" },
    other: { scheme: "scratch", owner: { workId: "other" }, path: "/" },
    lineage: { scheme: "scratch", owner: { rootThreadId: "lineage" }, path: "/" },
    act: { scheme: "scratch", owner: { workId: "work" }, path: "/Act" },
    a: { scheme: "scratch", owner: { workId: "work" }, path: "/Act/Notes" },
    b: { scheme: "scratch", owner: { workId: "other" }, path: "/Act/Notes" },
    c: { scheme: "scratch", owner: { rootThreadId: "lineage" }, path: "/Act/Notes" },
  };
  return {
    tree: {
      heading: "Project",
      children: (id) =>
        (
          ({ root: ["other", "work"], work: ["act"], act: ["a"], other: ["b"], lineage: ["c"] })[
            id ?? "root"
          ] ?? []
        ).map(node),
    },
    folderFor: (id) =>
      folders[id as keyof typeof folders] as ReturnType<ProjectMenuSource["folderFor"]>,
  };
}

it("resolves the retained full path in its owner, including an unlisted lineage", () => {
  const tree = source();
  expect(
    moveRepairTrail(
      tree,
      {
        scheme: "scratch",
        workId: "work",
        workSlug: "work",
        folderPath: "Act/Notes",
        name: "note.md",
      },
      [],
    )?.map((n) => n.id),
  ).toEqual(["work", "act", "a"]);
  expect(
    moveRepairTrail(
      tree,
      {
        scheme: "scratch",
        workId: null,
        rootThreadId: "lineage",
        rootThreadRef: "c12",
        folderPath: "/Act/Notes",
        name: "note.md",
      },
      [node("lineage")],
    )?.map((n) => n.id),
  ).toEqual(["lineage", "c"]);
});

it("does not invent a trail when the retained destination is gone", () => {
  expect(
    moveRepairTrail(
      source(),
      { scheme: "scratch", workId: "work", workSlug: "work", folderPath: "/gone", name: "note.md" },
      [],
    ),
  ).toBeNull();
});
