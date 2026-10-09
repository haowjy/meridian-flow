/** Warm exact content resolves readable routes independently from network address lookup. */

import type { DocumentAddressResult } from "@meridian/contracts/protocol";
import { catalogViewFromSnapshot } from "@meridian/resource-replica";
import { describe, expect, it } from "vitest";
import type { CatalogContextView, CatalogFile } from "@/client/query/context-catalog-projection";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import {
  gateLiveView,
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

it("never answers a bound document the catalog does not list with the path's occupant", () => {
  // Document A is bound to the route but is not in the live catalog (a pending new-document
  // draft); B, which has local content, now holds the path the URL names.
  const destination = { kind: "document" as const, scheme: "kb" as const, path: "Cached.md" };
  expect(
    resolveLocalDocumentAddress("project-id", destination, null, catalog(true), "document-a"),
  ).toBeUndefined();
  // With no bound identity, the occupant is the route's document.
  expect(
    resolveLocalDocumentAddress("project-id", destination, null, catalog(true), null),
  ).toMatchObject({ file: { documentId: "document-id" } });
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
      isNewDocument,
      draft: { draftId: "draft-id", status: "active", isNewDocument },
    }) as unknown as ReviewFileTarget;
  const ready = (...files: ReviewFileTarget[]) => ({ status: "ready", files });
  const noTab = () => false;

  it("opens a manuscript document missing from the live manifest as its pending new-document draft, never live", () => {
    expect(gateLiveView(resolved, "manuscript", manifest(["document-id"]), ready(), noTab)).toEqual(
      { outcome: "ready", result: resolved },
    );
    expect(
      gateLiveView(resolved, "manuscript", manifest([]), ready(group(true)), noTab),
    ).toMatchObject({
      outcome: "ready",
      result: resolved,
      draftOnly: { draft: { draftId: "draft-id" } },
    });
    // Discarded, or a draft of an existing document: no live view and no review.
    expect(gateLiveView(resolved, "manuscript", manifest([]), ready(), noTab).result).toEqual({
      kind: "unavailable",
    });
    expect(
      gateLiveView(resolved, "manuscript", manifest([]), ready(group(false)), noTab).result,
    ).toEqual({ kind: "unavailable" });
  });

  it("calls absence unavailable only on an authoritative read, and keeps a promoted tab live", () => {
    // A stored checkpoint stays complete while its refresh is in flight: still pending.
    expect(
      gateLiveView(resolved, "manuscript", manifest([], { isFetching: true }), ready(), noTab),
    ).toEqual({ outcome: "pending", result: undefined });
    expect(
      gateLiveView(resolved, "manuscript", manifest([]), { status: "loading", files: null }, noTab),
    ).toEqual({ outcome: "pending", result: undefined });
    // Apply promoted the tab; the lagging catalog does not get to veto it.
    expect(
      gateLiveView(resolved, "manuscript", manifest([], { isFetching: true }), ready(), () => true)
        .result,
    ).toBe(resolved);
  });

  it("reports a failed prerequisite as failed, distinct from one still loading", () => {
    // A failed read is not evidence of no draft, and it must not wait forever.
    expect(
      gateLiveView(resolved, "manuscript", manifest([], { isError: true }), ready(), noTab),
    ).toEqual({ outcome: "failed", result: undefined });
    expect(
      gateLiveView(resolved, "manuscript", manifest([]), { status: "error", files: [] }, noTab),
    ).toEqual({ outcome: "failed", result: undefined });
  });
});

const kbRoute = { kind: "document" as const, scheme: "kb" as const, path: "Original.md" };
function bound(workId: string, documentId = "doc-a") {
  return {
    status: "bound" as const,
    revision: 1,
    locator: { scheme: "kb" as const, path: "/Original.md", workId },
    identity: { kind: "server" as const, documentId },
  };
}

it.each([
  ["doc-b", "no-work", "no-work", null],
  ["doc-a", "no-work", "no-work", "doc-a"],
  ["doc-a", "work-1", "no-work", null],
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
