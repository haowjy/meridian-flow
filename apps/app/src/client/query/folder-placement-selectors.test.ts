/** Tree and tab selectors must agree even when only the moved folder has a journal. */
import {
  catalogViewFromSnapshot,
  installFolderNamespaceAvailability,
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
import { projectCatalogView, projectResourceCatalogView } from "./useContextCatalog";

const record: ResourceRecord = {
  resource: {
    handle: "f",
    revision: 1,
    identity: { documentId: "f", revision: 1 },
    content: { kind: "unacquired" },
    classification: { editable: true, filetype: "markdown", schemaType: "document" },
    canonical: loc("P/A/doc.md"),
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
    { kind: "available", location: loc(destination) },
  )!.next;
  for (const folder of [pending, accepted, refreshed]) {
    const projected = projectResourceCatalogView("p", scope, view(), [record], [folder]);
    const selected = projectCatalogView("p", "manuscript", projected, [record], [folder]);
    expect(selected.findDocument("f")?.path).toBe(`/${destination}/doc.md`);
    expect(contextTabFromResource("p", record, [folder])).toMatchObject({
      path: `/${destination}/doc.md`,
    });
  }
});

it("exposes unavailable folder repair without a catalog row", () => {
  const queued = del("A", "P/A", outcome(submit(move("A", "P/A", "B/A")), true));
  const folder = installFolderNamespaceAvailability(queued, queued.canonicalRefresh!.operationId, {
    kind: "unavailable",
  })!.next;
  const projected = projectResourceCatalogView(
    "p",
    scope,
    view(entries.filter((e) => !["A", "f"].includes(e.entryId))),
    [],
    [folder],
  );
  const selected = projectCatalogView("p", "manuscript", projected, [], [folder]);
  expect(selected.findPath("/B/A")).toMatchObject({ entryId: "A", namespaceFailure: "delete" });
  expect(selected.children("B")).toContainEqual(
    expect.objectContaining({ entryId: "A", namespaceFailure: "delete" }),
  );
});
