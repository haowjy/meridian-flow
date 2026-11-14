/** Retained moves resolve by folder identity, never by path or basename. */
import { Folder } from "lucide-react";
import { expect, it } from "vitest";
import type { DrillNode } from "@/components/app/DrillInMenu";
import { moveRepairTrail } from "./move-repair-trail";
import type { ProjectMenuSource } from "./use-project-menu-source";

const node = (id: string): DrillNode => ({ id, name: "Notes", folder: true, icon: Folder });
function source(): Pick<ProjectMenuSource, "tree" | "folderFor"> {
  const folders = {
    work: "/",
    other: "/",
    lineage: "/",
    act: "/Act",
    a: "/Act/Notes",
    b: "/Act/Notes",
    c: "/Act/Notes",
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
      ({
        scheme: "scratch",
        owner: {},
        path: folders[id as keyof typeof folders],
        entryId: id,
      }) as ReturnType<ProjectMenuSource["folderFor"]>,
  };
}

it("resolves the retained folder by its id, including an unlisted lineage", () => {
  const tree = source();
  expect(moveRepairTrail(tree, { parentId: "a" }, [])?.map((n) => n.id)).toEqual([
    "work",
    "act",
    "a",
  ]);
  expect(moveRepairTrail(tree, { parentId: "c" }, [node("lineage")])?.map((n) => n.id)).toEqual([
    "lineage",
    "c",
  ]);
});

it("does not invent a trail when the retained destination is gone", () => {
  expect(moveRepairTrail(source(), { parentId: "/gone" }, [])).toBeNull();
});
