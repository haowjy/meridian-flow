/** Bulk canonical paths share one document read and one folder-graph read. */
import type { Database } from "@meridian/database";
import { expect, it } from "vitest";
import type { ProjectWorkAuthorityResolver } from "../projects/index.js";
import { createDocumentUrisResolver } from "./document-uri-resolver.js";

it("resolves shared nested paths and absent documents in two reads", async () => {
  let reads = 0;
  const documentRows = ["a", "b"].map((id) => ({
    id,
    name: id,
    extension: "md",
    folderId: "child",
    sourceId: "source",
    sourceSlug: "manuscript",
    workId: null,
    workProjectId: null,
  }));
  const folderRows = [
    { id: "parent", parentId: null, name: "Book" },
    { id: "child", parentId: "parent", name: "Chapters" },
  ];
  const db = {
    select: () => {
      const rows = reads++ === 0 ? documentRows : folderRows;
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: async () => rows,
      };
      return chain;
    },
  } as unknown as Database;
  const resolve = createDocumentUrisResolver(db, {} as ProjectWorkAuthorityResolver);
  expect(await resolve(["a", "b", "absent"])).toEqual(
    new Map([
      ["a", "manuscript://Book/Chapters/a.md"],
      ["b", "manuscript://Book/Chapters/b.md"],
      ["absent", null],
    ]),
  );
  expect(reads).toBe(2);
  expect(await resolve([])).toEqual(new Map());
  expect(reads).toBe(2);
});
