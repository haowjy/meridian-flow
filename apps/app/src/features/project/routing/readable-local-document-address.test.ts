/** Warm exact content resolves readable routes independently from network address lookup. */
import { catalogViewFromSnapshot } from "@meridian/resource-replica";
import { expect, it } from "vitest";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import {
  mergeLocalResourceState,
  reconcileDocumentAddress,
  resolveLocalDocumentAddress,
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
    projectId: "project-id",
    scheme: "kb",
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

it("admits an exact cached readable path before a failed remote lookup matters", () => {
  expect(
    resolveLocalDocumentAddress(
      "project-id",
      { kind: "document", scheme: "kb", path: "Cached.md", workSlug: null },
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
      { kind: "document", scheme: "kb", path: "Cached.md", workSlug: null },
      catalog(false),
    ),
  ).toBeUndefined();
});

it("uses local content through lookup failure, then yields to a successful canonical result", () => {
  const local = resolveLocalDocumentAddress(
    "project-id",
    { kind: "document", scheme: "kb", path: "Cached.md", workSlug: null },
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
