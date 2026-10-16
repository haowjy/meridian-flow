/** Identity traversal must retain authority when a move changes owner but not path. */
import type { CatalogEntry } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { planFolderLocation } from "./folder-namespace";
import { projectFolderCatalog } from "./folder-projection";
import type { ResourceLocation } from "./resource-records";

const scope = (workId: string) => ({ kind: "work" as const, projectId: "p", workId });
const loc = (workId: string, path: string): ResourceLocation => ({
  scheme: "scratch",
  path: `/${path}`,
  name: path.split("/").at(-1)!,
  workId,
  workSlug: workId,
});
const source = (w: string): CatalogEntry => ({
  kind: "source",
  entryId: `s${w}`,
  scheme: "scratch",
  name: w,
  uri: `scratch://@${w}/`,
  scope: scope(w),
});
const node = (id: string, w: string, path: string, parentId = `s${w}`): CatalogEntry => ({
  observationVersion: "1",
  kind: "folder",
  entryId: id,
  sourceId: `s${w}`,
  parentId,
  scope: scope(w),
  name: path.split("/").at(-1)!,
  path: path.split("/"),
  uri: `scratch://@${w}/${path}`,
  hasChildren: true,
});
const move = (id: string, from: string, path: string, to: string, destination: string) => {
  const parts = destination.split("/");
  return planFolderLocation({
    projectId: "p",
    handle: id,
    folderId: id,
    source: loc(from, path),
    intentId: `i${id}`,
    operationId: `o${id}`,
    destination: {
      parent:
        parts.length > 1
          ? { kind: "folder", folderId: "sub" }
          : { kind: "root", scheme: "scratch", owner: { workId: to, workSlug: to } },
      name: parts.at(-1)!,
    },
  })!.next;
};
it("binds a descendant through a same-path cross-Work parent in either record order", () => {
  const entries = [
    source("alpha"),
    source("beta"),
    node("B", "alpha", "B"),
    node("sub", "alpha", "B/sub", "B"),
    node("X", "beta", "X"),
  ];
  const b = move("B", "alpha", "B", "beta", "B");
  const x = move("X", "beta", "X", "beta", "B/sub/X");
  for (const records of [
    [b, x],
    [x, b],
  ])
    expect(
      projectFolderCatalog("p", entries, records).find((e) => e.entryId === "X"),
    ).toMatchObject({ uri: "scratch://@[beta]/B/sub/X", parentId: "sub" });
});

it("marks a document pending when its parent changes owner without changing path", async () => {
  const { createResourcePlacement } = await import("./folder-projection");
  const record = {
    resource: {
      handle: "doc",
      revision: 1,
      identity: { documentId: "doc", revision: 1 },
      content: { kind: "unacquired" as const },
      classification: {
        editable: true as const,
        filetype: "markdown" as const,
        schemaType: "document" as const,
      },
      canonical: loc("alpha", "B/doc.md"),
      canonicalParent: { kind: "folder" as const, folderId: "B" },
      lifecycle: { kind: "acknowledged" as const, availabilityGeneration: "1" },
      aliases: {},
      obligations: {},
    },
    intents: [],
  };
  const placement = createResourcePlacement(
    "p",
    [source("alpha"), source("beta"), node("B", "alpha", "B")],
    [move("B", "alpha", "B", "beta", "B")],
  );
  expect(placement.resourceLocation(record)).toMatchObject({ path: "/B/doc.md", workId: "beta" });
  expect(placement.resourcePlacementPending(record)).toBe(true);
});
