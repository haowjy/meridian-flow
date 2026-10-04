/** Warm exact content resolves readable routes independently from network address lookup. */

import { parseRequestId } from "@meridian/contracts/request-id";
import { catalogViewFromSnapshot } from "@meridian/resource-replica";
import { expect, it } from "vitest";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import {
  mergeLocalResourceState,
  reconcileDocumentAddress,
  resolveLocalDocumentAddress,
  routeContinuityDocumentId,
} from "./local-document-address";

function catalog(localContent: boolean): CatalogContextView {
  const scope = { kind: "project" as const, projectId: "project-id" };
  const normalized = catalogViewFromSnapshot({
    scope,
    generation: "cached",
    headRevision: "1",
    cursor: "cursor",
    entries: [
      {
        kind: "source",
        entryId: "kb-source",
        scope,
        scheme: "kb",
        name: "Knowledge Base",
        uri: "kb://",
      },
      {
        kind: "file",
        entryId: "document-id",
        scope,
        sourceId: "kb-source",
        parentId: "kb-source",
        name: "Cached.md",
        aliases: [],
        path: ["Cached.md"],
        uri: "kb://Cached.md",
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    ],
  });
  const file: CatalogFile = {
    kind: "file",
    entryId: "document-id",
    parentId: "kb-source",
    documentId: "document-id",
    name: "Cached.md",
    aliases: [],
    path: "/Cached.md",
    uri: "kb://Cached.md",
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    resourceHandle: "resource-id",
    resourceState: "acknowledged",
    ...(localContent ? { localContent: true as const } : {}),
  };
  return {
    normalized,
    root: {
      kind: "dir",
      entryId: "kb-source",
      parentId: null,
      name: "Knowledge Base",
      path: "/",
      uri: "kb://",
    },
    children: () => [file],
    files: () => [file],
    findPath: (path) => (path === file.path ? file : null),
    findDocument: (documentId) => (documentId === file.documentId ? file : null),
  };
}

function workCatalog(workId: string, localContent: boolean): CatalogContextView {
  const scope = { kind: "work" as const, projectId: "project-id", workId };
  const uri = "scratch://@chapter-drafts/notes.md";
  const normalized = catalogViewFromSnapshot({
    scope,
    generation: "cached",
    headRevision: "1",
    cursor: "cursor",
    entries: [
      {
        kind: "source",
        entryId: "scratch-source",
        scope,
        scheme: "scratch",
        name: "Scratch",
        uri: "scratch://@chapter-drafts",
      },
      {
        kind: "file",
        entryId: "document-id",
        scope,
        sourceId: "scratch-source",
        parentId: "scratch-source",
        name: "notes.md",
        aliases: [],
        path: ["notes.md"],
        uri,
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    ],
  });
  const file: CatalogFile = {
    kind: "file",
    entryId: "document-id",
    parentId: "scratch-source",
    documentId: "document-id",
    name: "notes.md",
    aliases: [],
    path: "/notes.md",
    uri,
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
    ...(localContent ? { localContent: true as const } : {}),
  };
  return {
    normalized,
    root: {
      kind: "dir",
      entryId: "scratch-source",
      parentId: null,
      name: "Scratch",
      path: "/",
      uri: "scratch://@chapter-drafts",
    },
    children: () => [file],
    files: () => [file],
    findPath: (path) => (path === file.path ? file : null),
    findDocument: (documentId) => (documentId === file.documentId ? file : null),
  };
}

it("admits an exact cached readable path before a failed remote lookup matters", () => {
  expect(
    resolveLocalDocumentAddress(
      "project-id",
      { kind: "document", scheme: "kb", path: "Cached.md" },
      null,
      catalog(true),
    ),
  ).toMatchObject({
    file: { documentId: "document-id", localContent: true },
    result: {
      kind: "current",
      document: { documentId: "document-id", generation: "0" },
    },
  });
});

it("does not turn metadata-only catalog discovery into blank local content", () => {
  expect(
    resolveLocalDocumentAddress(
      "project-id",
      { kind: "document", scheme: "kb", path: "Cached.md" },
      null,
      catalog(false),
    ),
  ).toBeUndefined();
});

it("resolves a Work-scoped path through its id and takes the context URI slug from the catalog", () => {
  const workId = parseRequestId("123e4567-e89b-42d3-a456-426614174000");
  if (!workId) throw new Error("Invalid test Work ID");
  const result = resolveLocalDocumentAddress(
    "project-id",
    { kind: "document", scheme: "scratch", path: "notes.md" },
    workId,
    workCatalog(workId, true),
  );
  expect(result?.result).toMatchObject({
    kind: "current",
    document: {
      authority: {
        kind: "work",
        workId,
        workSlug: "chapter-drafts",
      },
    },
  });
  expect(
    resolveLocalDocumentAddress(
      "project-id",
      { kind: "document", scheme: "scratch", path: "notes.md" },
      parseRequestId("123e4567-e89b-42d3-a456-426614174001"),
      workCatalog(workId, true),
    ),
  ).toBeUndefined();
});

it("uses local content through lookup failure, then yields to a successful canonical result", () => {
  const local = resolveLocalDocumentAddress(
    "project-id",
    { kind: "document", scheme: "kb", path: "Cached.md" },
    null,
    catalog(true),
  );
  if (!local || local.result.kind === "unavailable") throw new Error("Expected a local address");
  expect(reconcileDocumentAddress(local, { kind: "unavailable" })).toMatchObject({
    result: { kind: "current", document: { documentId: "document-id" } },
    localFile: { documentId: "document-id" },
  });

  const canonical = {
    kind: "alias" as const,
    document: {
      ...local.result.document,
      documentId: "canonical-id",
      entry: {
        ...local.result.document.entry,
        entryId: "canonical-id",
        name: "Canonical.md",
        path: ["Canonical.md"],
        uri: "kb://Canonical.md",
      },
    },
  };
  expect(reconcileDocumentAddress(local, canonical)).toEqual({
    result: canonical,
    localFile: undefined,
  });
});

it("keeps the path of the writer's unconfirmed move over a server alias for the same document", () => {
  const local = resolveLocalDocumentAddress(
    "project-id",
    { kind: "document", scheme: "kb", path: "Cached.md" },
    null,
    catalog(true),
  );
  if (!local || local.result.kind === "unavailable") throw new Error("Expected a local address");
  // A rename back to a name the server still redirects answers with an alias of this document.
  const alias = { kind: "alias" as const, document: local.result.document };
  const pending = { ...local, file: { ...local.file, placementPending: true as const } };

  expect(reconcileDocumentAddress(pending, alias)).toEqual({
    result: local.result,
    localFile: pending.file,
  });
  expect(reconcileDocumentAddress(local, alias).result).toBe(alias);
});

it("keeps local ownership while canonical metadata replaces a stale same-ID path", () => {
  const local = catalog(true).findDocument("document-id");
  if (!local) throw new Error("Expected local file");
  const {
    resourceHandle: _resourceHandle,
    resourceState: _resourceState,
    localContent: _localContent,
    ...canonicalBase
  } = local;
  const canonical: CatalogFile = {
    ...canonicalBase,
    name: "Canonical.md",
    path: "/Canonical.md",
    uri: "kb://Canonical.md",
  };

  expect(mergeLocalResourceState(canonical, local)).toMatchObject({
    documentId: "document-id",
    name: "Canonical.md",
    path: "/Canonical.md",
    uri: "kb://Canonical.md",
    resourceHandle: "resource-id",
    resourceState: "acknowledged",
    localContent: true,
  });
});

const kbRoute = { kind: "document" as const, scheme: "kb" as const, path: "Original.md" };
function bound(workId: string | null, documentId = "doc-a") {
  return {
    status: "bound" as const,
    revision: 1,
    locator: { scheme: "kb" as const, path: "/Original.md", workId },
    identity: { kind: "server" as const, documentId },
  };
}

it.each([
  [null, null, null, null],
  ["doc-b", null, null, null],
  ["doc-a", null, null, "doc-a"],
  ["doc-a", "work-1", "work-1", "doc-a"],
  ["doc-a", "work-1", null, null],
])("requires admission %s and matching Editor context %s / %s", (admittedDocumentId, editorWorkId, selectionWork, expected) => {
  expect(
    routeContinuityDocumentId({
      destination: kbRoute,
      admittedDocumentId,
      editorWorkId,
      selection: bound(selectionWork),
    }),
  ).toBe(expected);
});
