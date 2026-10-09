/** Catalog installation keeps server projection and local resource truth in one commit plan. */

import type { CatalogScope, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import type { CatalogCacheView } from "./catalog";
import { catalogViewFromSnapshot } from "./catalog";
import { planCatalogInstallation } from "./catalog-installation";
import type { ResourceRecord } from "./resource-records";

const projectId = "project";

function view(documentId = "document", uri = "manuscript://chapter.md"): CatalogCacheView {
  return catalogViewFromSnapshot({
    scope: { kind: "project", projectId },
    generation: "generation",
    headRevision: "1",
    cursor: "cursor",
    entries: [
      {
        kind: "source",
        entryId: "source",
        scope: { kind: "project", projectId },
        scheme: "manuscript",
        name: "Manuscript",
        uri: "manuscript://",
      },
      {
        kind: "file",
        entryId: documentId,
        scope: { kind: "project", projectId },
        sourceId: "source",
        parentId: "source",
        name: "chapter.md",
        aliases: [],
        path: ["chapter.md"],
        uri,
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    ],
  });
}

function scopedView(
  scope: CatalogScope,
  scheme: ProjectContextTreeScheme,
  uri: string,
): CatalogCacheView {
  return catalogViewFromSnapshot({
    scope,
    generation: "generation",
    headRevision: "1",
    cursor: "cursor",
    entries: [
      { kind: "source", entryId: "source", scope, scheme, name: scheme, uri: `${scheme}://` },
      {
        kind: "file",
        entryId: "scoped-document",
        scope,
        sourceId: "source",
        parentId: "source",
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
}

function record(overrides: Partial<ResourceRecord["resource"]> = {}): ResourceRecord {
  return {
    resource: {
      handle: "local-handle",
      revision: 1,
      identity: { documentId: "document", revision: 1 },
      content: { kind: "exact", databaseName: "exact", schema: "0.5" },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: {},
      ...overrides,
      classification: overrides.classification ?? {
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    },
    intents: [],
  };
}

function observed(record: ResourceRecord, revision = record.resource.revision) {
  return {
    resources: new Map([
      [
        record.resource.handle,
        {
          revision,
          canonical: structuredClone(record.resource.canonical),
          classification: structuredClone(record.resource.classification),
        },
      ],
    ]),
  };
}

describe("planCatalogInstallation", () => {
  it("does not overwrite canonical location until a post-receipt observation", () => {
    const current = record({
      lifecycle: { kind: "acknowledged", availabilityGeneration: "authority" },
      canonical: { scheme: "manuscript", path: "/old.md", name: "old.md", workId: null },
      obligations: { canonicalRefresh: { operationId: "move", identityRevision: 1 } },
    });
    const stale = planCatalogInstallation({ projectId, records: [current], view: view() });
    expect(stale.resources).toEqual([]);

    const fresh = planCatalogInstallation({
      projectId,
      records: [current],
      view: view(),
      observedAfter: observed(current),
    });
    expect(fresh.resources[0]?.next.resource).toMatchObject({
      canonical: { path: "/chapter.md" },
      obligations: {},
    });
  });

  it("leaves locally reserved creation under namespace outcome ownership", () => {
    const current = record({
      content: {
        kind: "exact",
        databaseName: "exact",
        schema: "0.5",
        initialization: "reserved",
      },
    });
    expect(
      planCatalogInstallation({
        projectId,
        records: [current],
        view: view(),
        observedAfter: observed(current),
      }).resources,
    ).toEqual([]);
  });

  it("does not resurrect terminal resources or infer deletion from scope absence", () => {
    const terminal = record({
      lifecycle: { kind: "terminal", generation: "gone", transitionId: "delete" },
    });
    expect(
      planCatalogInstallation({ projectId, records: [terminal], view: view() }).resources,
    ).toEqual([]);
    expect(
      planCatalogInstallation({
        projectId,
        records: [record()],
        view: catalogViewFromSnapshot({
          scope: { kind: "project", projectId },
          generation: "generation",
          headRevision: "1",
          cursor: "empty",
          entries: [],
        }),
      }).resources,
    ).toEqual([]);
  });

  it("does not confuse a reminted local alias with the server document that retained that ID", () => {
    const current = record({
      identity: { documentId: "new-document", revision: 2 },
      aliases: {
        document: { introducedAtIdentityRevision: 2 },
      },
    });
    expect(
      planCatalogInstallation({ projectId, records: [current], view: view("document") })
        .resources[0]?.next.resource,
    ).toMatchObject({ handle: "catalog:document", identity: { documentId: "document" } });
  });

  it("rejects a catalog whose URI disagrees with its scope and path", () => {
    expect(() =>
      planCatalogInstallation({
        projectId,
        records: [],
        view: view("document", "scratch://@some-work/chapter.md"),
      }),
    ).toThrow("Catalog file URI");
    // A lineage catalog holds only that chat's Scratch: no Work spelling, no missing handle.
    for (const uri of ["scratch://@drafting/notes.md", "scratch://@/"])
      expect(() =>
        planCatalogInstallation({
          projectId,
          records: [],
          view: scopedView({ kind: "lineage", projectId, rootThreadId: "root-id" }, "scratch", uri),
        }),
      ).toThrow();
  });

  it.each([
    {
      scope: { kind: "user", userId: "user" } as const,
      scheme: "user" as const,
      uri: "user://notes.md",
      expected: { scheme: "user", workId: null },
    },
    {
      scope: { kind: "work", projectId, workId: "no-work-id" } as const,
      scheme: "uploads" as const,
      uri: "uploads://@/notes.md",
      expected: { scheme: "uploads", workId: "no-work-id" },
    },
    {
      scope: { kind: "lineage", projectId, rootThreadId: "root-id" } as const,
      scheme: "scratch" as const,
      uri: "scratch://@/c12/notes.md",
      expected: { scheme: "scratch", workId: null, rootThreadId: "root-id", rootThreadRef: "c12" },
    },
    {
      scope: { kind: "work", projectId, workId: "work-id" } as const,
      scheme: "scratch" as const,
      uri: "scratch://@drafting/notes.md",
      expected: { scheme: "scratch", workId: "work-id", workSlug: "drafting" },
    },
  ])("derives canonical authority for $scope.kind scope", ({ scope, scheme, uri, expected }) => {
    const result = planCatalogInstallation({
      projectId,
      records: [],
      view: scopedView(scope, scheme, uri),
    });
    expect(result.resources[0]?.next.resource.canonical).toMatchObject(expected);
  });
});
