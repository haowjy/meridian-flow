/** Refused commands retain parent identity, separating rename from move repair.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - refused-move parent comparison
 * - client catalog projection over replica placement
 */
import {
  catalogViewFromSnapshot,
  createResourcePlacement,
  installFolderNamespaceAvailability,
  type ParentRef,
  type ResourceDestination,
  type ResourceRecord,
} from "@meridian/resource-replica";
import { expect, it } from "vitest";
import { contextTabFromResource } from "@/features/project/context/context-tab-from-file";
import {
  del,
  entries,
  loc,
  move,
  outcome,
  scope,
  submit,
} from "../../../../../packages/resource-replica/src/namespace-schedule-fixtures";
import { refusedMoveDestination } from "./context-catalog-projection";
import { projectCatalogView, projectResourceCatalogView } from "./useContextCatalog";

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
    owner: { workId: "work", workHandle: "w1" },
  };
  const other: ResourceDestination = {
    parent: { kind: "root", scheme: "scratch", owner: { workId: "other", workHandle: "w2" } },
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

const record: ResourceRecord = {
  resource: {
    handle: "f",
    revision: 1,
    identity: { documentId: "f", revision: 1 },
    content: { kind: "unacquired" },
    classification: { editable: true, filetype: "markdown", schemaType: "document" },
    canonical: loc("P/A/doc.md"),
    serverHold: "held",
    lifecycle: { kind: "acknowledged", availabilityGeneration: "1" },
    aliases: {},
    obligations: {},
  },
  intents: [],
};
const view = (catalogEntries = entries) =>
  catalogViewFromSnapshot({
    scope,
    generation: "g",
    headRevision: "1",
    cursor: "c",
    entries: catalogEntries,
  });

it.each([
  "B/A",
  "P/R",
])("keeps descendants visible and tabs at %s through folder-only refresh", (destination) => {
  const pending = move("A", "P/A", destination);
  const accepted = outcome(submit(pending), true);
  const refreshed = installFolderNamespaceAvailability(
    accepted,
    accepted.canonicalRefresh!.operationId,
    {
      observationVersion: "1",
      kind: "available",
      location: loc(destination),
      parent: { kind: "folder", folderId: destination.startsWith("B/") ? "B" : "P" },
    },
  )!.next;
  for (const folder of [pending, accepted, refreshed]) {
    const placement = createResourcePlacement("p", entries, [folder]);
    const projected = projectResourceCatalogView("p", scope, view(), [record], placement);
    const selected = projectCatalogView(
      "p",
      "manuscript",
      projected,
      placement,
      [record],
      [folder],
    );
    expect(
      [...projected.entries.values()]
        .filter((entry) => entry.kind === "folder" && entry.path.join("/") === destination)
        .map((entry) => entry.entryId),
    ).toEqual(["A"]);
    expect(selected.findDocument("f")?.path).toBe(`/${destination}/doc.md`);
    expect(contextTabFromResource("p", record, placement)).toMatchObject({
      path: `/${destination}/doc.md`,
    });
  }
});

it.each([
  false,
  true,
])("exposes unavailable folder repair without a catalog row (empty catalog: %s)", (empty) => {
  const queued = del("A", "P/A", outcome(submit(move("A", "P/A", "B/A")), true));
  const folder = installFolderNamespaceAvailability(queued, queued.canonicalRefresh!.operationId, {
    kind: "unavailable",
  })!.next;
  const known = empty ? [] : entries.filter((e) => !["A", "f"].includes(e.entryId));
  const placement = createResourcePlacement("p", known, [folder]);
  const projected = projectResourceCatalogView("p", scope, view(known), [], placement);
  const selected = projectCatalogView("p", "manuscript", projected, placement, [], [folder]);
  expect(selected.findPath("/P/A")).toMatchObject({ entryId: "A", namespaceFailure: "delete" });
  expect(selected.children(selected.findPath("/P")!.entryId)).toContainEqual(
    expect.objectContaining({ entryId: "A", namespaceFailure: "delete" }),
  );
});

it.each([
  "P",
  "B",
])("tree and tab suppression follows placed ancestry when deleting %s", (deleted) => {
  const folders = [move("A", "P/A", "B/A"), del(deleted, deleted)];
  const placement = createResourcePlacement("p", entries, folders);
  const projected = projectResourceCatalogView("p", scope, view(), [record], placement);
  const tree = projectCatalogView("p", "manuscript", projected, placement, [record], folders);
  if (deleted === "P") {
    expect(tree.findDocument("f")?.path).toBe("/B/A/doc.md");
    expect(contextTabFromResource("p", record, placement)).toMatchObject({ path: "/B/A/doc.md" });
  } else {
    expect(tree.findDocument("f")).toBeNull();
    expect(contextTabFromResource("p", record, placement)).toBeNull();
  }
});
