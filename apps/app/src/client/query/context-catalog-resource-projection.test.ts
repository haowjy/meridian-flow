/** Local resource overlays stay project-qualified and open through stable resource identity. */

import type { CatalogScope } from "@meridian/contracts/protocol";
import {
  catalogViewFromSnapshot,
  planResourceLocation,
  reserveResourceDocument,
} from "@meridian/resource-replica";
import { expect, it } from "vitest";
import {
  contextTabFromFile,
  contextTabFromResource,
} from "@/features/project/context/context-tab-from-file";
import { projectCatalogView, projectResourceCatalogView } from "./useContextCatalog";

const scope = { kind: "project" as const, projectId: "project-b" };

function emptyCatalog(catalogScope: CatalogScope = scope) {
  return catalogViewFromSnapshot({
    scope: catalogScope,
    generation: "generation",
    headRevision: "0",
    cursor: "cursor",
    entries: [],
  });
}

function catalogWithFile(
  catalogScope: CatalogScope,
  scheme: "manuscript" | "kb" | "user" | "unfiled",
  documentId: string,
  path: string,
  aliases: readonly string[] = [],
) {
  const segments = path.split("/").filter(Boolean);
  const name = segments.at(-1) ?? "";
  const sourceId = `source-${scheme}`;
  return catalogViewFromSnapshot({
    scope: catalogScope,
    generation: "generation",
    headRevision: "0",
    cursor: "cursor",
    entries: [
      {
        kind: "source",
        entryId: sourceId,
        scope: catalogScope,
        scheme,
        name: scheme,
        uri: `${scheme}://`,
      },
      {
        kind: "file",
        entryId: documentId,
        scope: catalogScope,
        sourceId,
        parentId: sourceId,
        name,
        aliases,
        path: segments,
        uri: `${scheme}://${segments.join("/")}`,
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    ],
  });
}

function projectedCatalog(
  projectId: string,
  scheme: "manuscript" | "kb" | "user" | "unfiled",
  records: Parameters<typeof projectResourceCatalogView>[3],
  catalogScope = scheme === "user"
    ? ({ kind: "user", userId: "self" } as const)
    : ({ kind: "project", projectId } as const),
) {
  const normalized = projectResourceCatalogView(
    projectId,
    catalogScope,
    emptyCatalog(catalogScope),
    records,
  );
  return projectCatalogView(projectId, scheme, normalized, records);
}

it("projects a reserved document and opens it through its resource handle", () => {
  const record = reserveResourceDocument({
    projectId: "project-b",
    handle: "resource-b",
    documentId: "document-b",
    databaseName: "content-b",
    schema: "schema",
    intentId: "create-b",
    provisionalName: "Untitled 2",
  }).next;

  const catalog = projectedCatalog("project-b", "unfiled", [record]);
  const file = catalog.findDocument("document-b");

  expect(file).toMatchObject({
    name: "Untitled 2",
    path: "/Untitled 2",
    resourceHandle: "resource-b",
  });
  expect(file).not.toHaveProperty("localContent");
  if (!file) throw new Error("Expected local catalog file");
  expect(contextTabFromFile("unfiled", file)).toEqual({
    kind: "new",
    documentId: "document-b",
    name: "Untitled 2",
    resourceHandle: "resource-b",
  });

  const initialized = structuredClone(record);
  if (initialized.resource.content.kind !== "exact") throw new Error("Expected exact content");
  delete initialized.resource.content.initialization;
  expect(
    projectedCatalog("project-b", "unfiled", [initialized]).findDocument("document-b"),
  ).toHaveProperty("localContent", true);
});

it("does not apply another project's pending placement to a shared resource", () => {
  const record = reserveResourceDocument({
    projectId: "project-a",
    handle: "shared-resource",
    documentId: "shared-document",
    databaseName: "shared-content",
    schema: "schema",
    intentId: "create-a",
    provisionalName: "A only",
  }).next;
  record.resource.canonical = {
    scheme: "user",
    path: "/shared.md",
    name: "shared.md",
    workId: null,
  };
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };

  const catalog = projectedCatalog("project-b", "user", [record]);

  expect(catalog.findDocument("shared-document")).toMatchObject({
    name: "shared.md",
    path: "/shared.md",
  });
});

it("does not expose another project's private placement", () => {
  const record = reserveResourceDocument({
    projectId: "project-a",
    handle: "project-a-resource",
    documentId: "project-a-document",
    databaseName: "project-a-content",
    schema: "schema",
    intentId: "create-a",
    provisionalName: "A only",
  }).next;
  const placed = planResourceLocation({
    record,
    projectId: "project-a",
    intentId: "place-a",
    eligibleAt: 1,
    destination: {
      scheme: "manuscript",
      folderPath: "",
      name: "Private.md",
      workId: null,
    },
  });
  if (!placed) throw new Error("Expected local placement");

  expect(
    projectedCatalog("project-b", "manuscript", [placed.next]).findDocument("project-a-document"),
  ).toBeNull();
});

it("opens an explicitly filed local document at its optimistic path", () => {
  const record = reserveResourceDocument({
    projectId: "project-b",
    handle: "resource-b",
    documentId: "document-b",
    databaseName: "content-b",
    schema: "schema",
    intentId: "create-b",
    provisionalName: "Untitled",
  }).next;
  const placed = planResourceLocation({
    record,
    projectId: "project-b",
    intentId: "place-b",
    eligibleAt: 1,
    destination: {
      scheme: "manuscript",
      folderPath: "chapters",
      name: "Opening.md",
      workId: null,
    },
  });
  if (!placed) throw new Error("Expected local placement");

  const catalog = projectedCatalog("project-b", "manuscript", [placed.next]);
  const file = catalog.findDocument("document-b");
  if (!file) throw new Error("Expected placed catalog file");
  expect(file).toMatchObject({ path: "/chapters/Opening.md", provisionalName: false });
  expect(contextTabFromFile("manuscript", file)).toMatchObject({
    kind: "tracked",
    documentId: "document-b",
    path: "/chapters/Opening.md",
    resourceHandle: "resource-b",
    origin: "local-resource",
  });
});

it("keeps optimistic ancestors navigable when the server invalidated an old folder", () => {
  const record = reserveResourceDocument({
    projectId: "project-b",
    handle: "resource-b",
    documentId: "document-b",
    databaseName: "content-b",
    schema: "schema",
    intentId: "create-b",
  }).next;
  const placed = planResourceLocation({
    record,
    projectId: "project-b",
    intentId: "place-b",
    eligibleAt: 1,
    destination: {
      scheme: "manuscript",
      folderPath: "drafts",
      name: "Chapter.md",
      workId: null,
    },
  });
  if (!placed) throw new Error("Expected local placement");
  const checkpoint = catalogViewFromSnapshot({
    scope,
    generation: "generation",
    headRevision: "1",
    cursor: "cursor",
    entries: [
      {
        kind: "source",
        entryId: "source-manuscript",
        scope,
        scheme: "manuscript",
        name: "Manuscript",
        uri: "manuscript://",
      },
      {
        kind: "folder",
        entryId: "old-drafts",
        scope,
        sourceId: "source-manuscript",
        parentId: "source-manuscript",
        name: "drafts",
        path: ["drafts"],
        uri: "manuscript://drafts",
        hasChildren: true,
      },
    ],
  });
  const base = { ...checkpoint, invalidatedEntryIds: new Set(["old-drafts"]) };

  const normalized = projectResourceCatalogView("project-b", scope, base, [placed.next]);
  const catalog = projectCatalogView("project-b", "manuscript", normalized, [placed.next]);
  const file = catalog.findDocument("document-b");
  const folder = catalog.findPath("/drafts");

  expect(file).toMatchObject({ path: "/drafts/Chapter.md" });
  expect(folder).toMatchObject({
    kind: "dir",
    entryId: expect.stringContaining("local-folder:"),
    name: "drafts",
  });
  if (folder?.kind !== "dir") throw new Error("Expected optimistic folder");
  expect(catalog.children(folder.entryId)).toEqual([
    expect.objectContaining({ documentId: "document-b" }),
  ]);
});

it("keeps path lookup inside the selected scheme", () => {
  const checkpoint = catalogViewFromSnapshot({
    scope,
    generation: "generation",
    headRevision: "1",
    cursor: "cursor",
    entries: [
      {
        kind: "source",
        entryId: "source-kb",
        scope,
        scheme: "kb",
        name: "Knowledge Base",
        uri: "kb://",
      },
      {
        kind: "folder",
        entryId: "kb-drafts",
        scope,
        sourceId: "source-kb",
        parentId: "source-kb",
        name: "drafts",
        path: ["drafts"],
        uri: "kb://drafts",
        hasChildren: false,
      },
      {
        kind: "source",
        entryId: "source-manuscript",
        scope,
        scheme: "manuscript",
        name: "Manuscript",
        uri: "manuscript://",
      },
      {
        kind: "folder",
        entryId: "manuscript-drafts",
        scope,
        sourceId: "source-manuscript",
        parentId: "source-manuscript",
        name: "drafts",
        path: ["drafts"],
        uri: "manuscript://drafts",
        hasChildren: false,
      },
    ],
  });

  expect(
    projectCatalogView("project-b", "manuscript", checkpoint).findPath("/drafts"),
  ).toMatchObject({
    entryId: "manuscript-drafts",
  });
});

it("restores a failed delete with a retry marker", () => {
  const record = reserveResourceDocument({
    projectId: "project-b",
    handle: "resource-b",
    documentId: "document-b",
    databaseName: "content-b",
    schema: "schema",
    intentId: "create-b",
    provisionalName: "Untitled",
  }).next;
  record.intents = [
    ...record.intents,
    {
      projectId: "project-b",
      handle: "resource-b",
      intentId: "delete-b",
      sequence: 2,
      identityRevision: 1,
      desired: { kind: "delete" },
      attempts: [],
      state: "needs-repair",
    },
  ];

  expect(
    projectedCatalog("project-b", "unfiled", [record]).findDocument("document-b"),
  ).toMatchObject({ namespaceFailure: "delete" });
});

it("restores a failed rename with an actionable repair marker", () => {
  const record = reserveResourceDocument({
    projectId: "project-b",
    handle: "resource-b",
    documentId: "document-b",
    databaseName: "content-b",
    schema: "schema",
    intentId: "create-b",
    provisionalName: "Original.md",
  }).next;
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  record.resource.canonical = {
    scheme: "unfiled",
    path: "/Original.md",
    name: "Original.md",
    workId: null,
  };
  record.intents = [
    ...record.intents,
    {
      projectId: "project-b",
      handle: "resource-b",
      intentId: "rename-b",
      sequence: 2,
      identityRevision: 1,
      desired: {
        kind: "set-location",
        destination: {
          scheme: "unfiled",
          folderPath: "",
          name: "Taken.md",
          workId: null,
        },
      },
      attempts: [],
      state: "needs-repair",
    },
  ];

  expect(
    projectedCatalog("project-b", "unfiled", [record]).findDocument("document-b"),
  ).toMatchObject({
    name: "Original.md",
    namespaceFailure: "set-location",
    namespaceRepairName: "Taken.md",
  });
});

it("replaces an acknowledged row with one optimistic rename projection", () => {
  const projectScope = { kind: "project" as const, projectId: "project-b" };
  const record = reserveResourceDocument({
    projectId: "project-b",
    handle: "resource-b",
    documentId: "document-b",
    databaseName: "content-b",
    schema: "schema",
    intentId: "create-b",
  }).next;
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  record.resource.canonical = {
    scheme: "manuscript",
    path: "/Old.md",
    name: "Old.md",
    workId: null,
  };
  const renamed = planResourceLocation({
    record,
    projectId: "project-b",
    intentId: "rename-b",
    eligibleAt: 1,
    destination: {
      scheme: "manuscript",
      folderPath: "",
      name: "New.md",
      workId: null,
    },
  });
  if (!renamed) throw new Error("Expected rename");
  const base = catalogWithFile(projectScope, "manuscript", "document-b", "Old.md");
  const normalized = projectResourceCatalogView("project-b", projectScope, base, [renamed.next]);
  const catalog = projectCatalogView("project-b", "manuscript", normalized, [renamed.next]);

  expect(catalog.files().map((file) => file.path)).toEqual(["/New.md"]);
});

it("moves a row across project schemes without retaining its source", () => {
  const projectScope = { kind: "project" as const, projectId: "project-b" };
  const record = reserveResourceDocument({
    projectId: "project-b",
    handle: "resource-b",
    documentId: "document-b",
    databaseName: "content-b",
    schema: "schema",
    intentId: "create-b",
  }).next;
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  record.resource.canonical = {
    scheme: "manuscript",
    path: "/Old.md",
    name: "Old.md",
    workId: null,
  };
  const moved = planResourceLocation({
    record,
    projectId: "project-b",
    intentId: "move-b",
    eligibleAt: 1,
    destination: { scheme: "kb", folderPath: "", name: "New.md", workId: null },
  });
  if (!moved) throw new Error("Expected move");
  const base = catalogWithFile(projectScope, "manuscript", "document-b", "Old.md");
  const normalized = projectResourceCatalogView("project-b", projectScope, base, [moved.next]);

  expect(projectCatalogView("project-b", "manuscript", normalized, [moved.next]).files()).toEqual(
    [],
  );
  expect(
    projectCatalogView("project-b", "kb", normalized, [moved.next])
      .files()
      .map((file) => file.path),
  ).toEqual(["/New.md"]);
});

it("keeps an unacquired catalog resource on the server session path", () => {
  const record = {
    resource: {
      handle: "catalog:server-document",
      revision: 1,
      identity: { documentId: "server-document", revision: 1 },
      content: { kind: "unacquired" },
      canonical: {
        scheme: "manuscript",
        path: "/Server.md",
        name: "Server.md",
        workId: null,
      },
      lifecycle: { kind: "acknowledged", availabilityGeneration: null },
      aliases: {},
      obligations: {},
    },
    intents: [],
  } as const;
  const base = catalogWithFile(scope, "manuscript", "server-document", "Server.md");
  const normalized = projectResourceCatalogView("project-b", scope, base, [record]);
  const file = projectCatalogView("project-b", "manuscript", normalized, [record]).findDocument(
    "server-document",
  );

  expect(contextTabFromResource("project-b", record)).not.toHaveProperty("resourceHandle");
  expect(file).not.toHaveProperty("resourceHandle");
  if (!file) throw new Error("Expected server catalog file");
  expect(contextTabFromFile("manuscript", file)).not.toHaveProperty("resourceHandle");
});
