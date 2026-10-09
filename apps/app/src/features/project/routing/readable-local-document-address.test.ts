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
  projectAddressMatchesContextTarget,
  reconcileDocumentAddress,
  resolveLocalDocumentAddress,
  routeContinuityDocumentId,
} from "./local-document-address";
import type { ProjectAddress } from "./project-address";

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
      gateLiveView(
        resolved,
        "manuscript",
        manifest([]),
        { status: "loading", groups: null },
        noTab,
      ),
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
      gateLiveView(resolved, "manuscript", manifest([]), { status: "error", groups: [] }, noTab),
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
  [null, "no-work", "no-work", null],
  ["doc-b", "no-work", "no-work", null],
  ["doc-a", "no-work", "no-work", "doc-a"],
  ["doc-a", "work-1", "work-1", "doc-a"],
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

describe("projectAddressMatchesContextTarget", () => {
  const noWorkId = "no-work";
  const address = (work: ProjectAddress["work"]): ProjectAddress => ({
    projectId: "project-id",
    destination: { kind: "document", scheme: "manuscript", path: "a.md" },
    work,
  });
  const target = (workId?: string) => ({ scheme: "manuscript", path: "/a.md", workId });

  it("names a No Work document by its row id, whatever the address spells", () => {
    expect(
      projectAddressMatchesContextTarget(address({ kind: "none" }), target(noWorkId), noWorkId),
    ).toBe(true);
    expect(
      projectAddressMatchesContextTarget(address({ kind: "none" }), target("work-1"), noWorkId),
    ).toBe(false);
  });

  it("reads an address that names no Work (a copied live URL) as the Editor's own Work", () => {
    // Same document, same Work: a review launch replaces the entry rather than pushing.
    expect(
      projectAddressMatchesContextTarget(
        address({ kind: "absent" }),
        target(noWorkId),
        noWorkId,
        undefined,
        noWorkId,
      ),
    ).toBe(true);
    // The Editor's Work is another one: a different destination.
    expect(
      projectAddressMatchesContextTarget(
        address({ kind: "absent" }),
        target(noWorkId),
        noWorkId,
        undefined,
        "work-1",
      ),
    ).toBe(false);
    expect(
      projectAddressMatchesContextTarget(address({ kind: "absent" }), target(noWorkId), noWorkId),
    ).toBe(false);
  });

  it("never matches a request whose Work is not yet resolved", () => {
    expect(projectAddressMatchesContextTarget(address({ kind: "none" }), target(), noWorkId)).toBe(
      false,
    );
  });
  describe("with document identity", () => {
    const named = (documentId: string, addressDocumentId?: string) =>
      projectAddressMatchesContextTarget(
        address({ kind: "none" }),
        { ...target(noWorkId), documentId },
        noWorkId,
        addressDocumentId,
      );

    it("lets identity decide once both sides know it", () => {
      // The same path reused by another document is not the same document.
      expect(named("document-a", "document-b")).toBe(false);
      // A renamed document is the same one, whatever path the request carries.
      expect(
        projectAddressMatchesContextTarget(
          address({ kind: "none" }),
          {
            scheme: "manuscript",
            path: "/old-name.md",
            workId: noWorkId,
            documentId: "document-a",
          },
          noWorkId,
          "document-a",
        ),
      ).toBe(true);
    });

    it("falls back to the path while the address is unresolved", () => {
      expect(named("document-a")).toBe(true);
    });

    it("still requires the Work to match when identity agrees", () => {
      expect(
        projectAddressMatchesContextTarget(
          address({ kind: "none" }),
          { ...target("work-1"), documentId: "document-a" },
          noWorkId,
          "document-a",
        ),
      ).toBe(false);
    });
  });
});
