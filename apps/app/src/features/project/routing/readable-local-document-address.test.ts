/** Warm exact content resolves readable routes independently from network address lookup. */

import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import { catalogViewFromSnapshot } from "@meridian/resource-replica";
import { describe, expect, it } from "vitest";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import type { ThreadDraftGroup } from "@/client/query/useWorkDrafts";
import {
  gateLiveView,
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

describe("gateLiveView", () => {
  const resolved = {
    kind: "current",
    document: { kind: "available", documentId: "document-id" },
  } as DocumentAddressResult;
  const manifest = (ids: string[], state: { isFetching?: boolean; isError?: boolean } = {}) =>
    ({
      catalog: { normalized: { entries: new Map(ids.map((id) => [id, {}])) } },
      isComplete: true,
      isFetching: false,
      isError: false,
      ...state,
    }) as unknown as Parameters<typeof gateLiveView>[2];
  const group = (isNewDocument: boolean) =>
    ({
      documentId: "document-id",
      draft: { draftId: "draft-id", status: "active", isNewDocument },
    }) as unknown as ThreadDraftGroup;
  const ready = (...groups: ThreadDraftGroup[]) => ({ status: "ready", groups });
  const noTab = () => false;

  it("opens a manuscript document missing from the live manifest as its pending new-document draft, never live", () => {
    expect(
      gateLiveView(resolved, "manuscript", manifest(["document-id"]), ready(), noTab).draftOnly,
    ).toBe(undefined);
    expect(
      gateLiveView(resolved, "manuscript", manifest([]), ready(group(true)), noTab),
    ).toMatchObject({ result: resolved, draftOnly: { draft: { draftId: "draft-id" } } });
    // Discarded, or a draft of an existing document: no live view and no review.
    expect(gateLiveView(resolved, "manuscript", manifest([]), ready(), noTab).result).toEqual({
      kind: "unavailable",
    });
    expect(
      gateLiveView(resolved, "manuscript", manifest([]), ready(group(false)), noTab).result,
    ).toEqual({ kind: "unavailable" });
  });

  it("calls absence unavailable only on an authoritative read, and keeps a promoted tab live", () => {
    // A stored checkpoint stays complete while its refresh is in flight, and a
    // failed draft read is not evidence of no draft: both are still loading.
    expect(
      gateLiveView(resolved, "manuscript", manifest([], { isFetching: true }), ready(), noTab)
        .result,
    ).toBeUndefined();
    expect(
      gateLiveView(resolved, "manuscript", manifest([], { isError: true }), ready(), noTab).result,
    ).toBeUndefined();
    expect(
      gateLiveView(resolved, "manuscript", manifest([]), { status: "error", groups: [] }, noTab)
        .result,
    ).toBeUndefined();
    // Apply promoted the tab; the lagging catalog does not get to veto it.
    expect(
      gateLiveView(resolved, "manuscript", manifest([], { isFetching: true }), ready(), () => true)
        .result,
    ).toBe(resolved);
  });
});
