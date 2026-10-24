import type {
  CatalogEntry,
  CatalogFolderEntry,
  CatalogScope,
  CatalogSnapshot,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  applyCatalogChanges,
  type CatalogCacheView,
  catalogFiles,
  catalogViewFromSnapshot,
} from "./catalog";
import { ResourceCatalogAcquisition } from "./catalog-acquisition";
import { planCatalogInstallation } from "./catalog-installation";
import {
  folderObservationFence,
  planFolderCatalogInstallation,
} from "./folder-catalog-installation";
import {
  installFolderNamespaceAvailability,
  validateFolderNamespaceUpdate,
} from "./folder-namespace";
import {
  entries as entriesFromNamespaceScheduleFixtures,
  loc,
  scope as scopeFromNamespaceScheduleFixtures,
} from "./namespace-schedule-fixtures";
import { committedResourceDeletion } from "./resource-deletion";
import { installNamespaceAvailability } from "./resource-namespace";
import type {
  ResourceMetadataStore,
  ResourceProjectionSnapshot,
  ResourceRecord,
} from "./resource-records";

const scope = { kind: "project", projectId: "project-1" } as const satisfies CatalogScope;
const source: CatalogEntry = {
  kind: "source",
  entryId: "source-1",
  scope,
  scheme: "manuscript",
  name: "Manuscript",
  uri: "manuscript://" as never,
};
const folder: CatalogEntry = {
  observationVersion: "1",
  kind: "folder",
  entryId: "folder-1",
  scope,
  sourceId: "source-1",
  parentId: "source-1",
  name: "Arc",
  path: ["Arc"],
  uri: "manuscript://Arc" as never,
  hasChildren: true,
};
const file: CatalogEntry = {
  observationVersion: "1",
  kind: "file",
  entryId: "document-1",
  scope,
  sourceId: "source-1",
  parentId: "folder-1",
  name: "Chapter.md",
  aliases: [],
  path: ["Arc", "Chapter.md"],
  uri: "manuscript://Arc/Chapter.md" as never,
  editable: true,
  filetype: "markdown",
  schemaType: "document",
  provisionalName: false,
};

describe("catalog cache reducer", () => {
  it("replaces a subtree atomically after a separately published upsert without retaining stale entries", () => {
    const stale = { ...file, entryId: "removed-document" };
    const initial = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source, folder, file, stale],
    });
    const renamed = {
      ...file,
      name: "Renamed.md",
      path: ["Arc", "Renamed.md"],
      uri: "manuscript://Arc/Renamed.md" as never,
    };
    const published = applyCatalogChanges(initial, {
      kind: "delta",
      scope,
      commits: [
        {
          eventId: "event-2",
          commitId: "commit-2",
          firstRevision: "2",
          lastRevision: "2",
          changes: [{ operation: "upsert", ordinal: 0, entry: renamed }],
        },
      ],
      nextCursor: "cursor-2",
      headRevision: "2",
      hasMore: false,
    });
    expect(published && catalogFiles(published)).toContainEqual(renamed);
    const delta = {
      kind: "delta" as const,
      scope,
      commits: [
        {
          eventId: "event-3",
          commitId: "commit-3",
          firstRevision: "3",
          lastRevision: "3",
          changes: [
            { operation: "invalidate-subtree" as const, ordinal: 0, rootEntryId: folder.entryId },
            { operation: "upsert" as const, ordinal: 1, entry: folder },
            { operation: "upsert" as const, ordinal: 2, entry: renamed },
          ],
        },
      ],
      nextCursor: "cursor-3",
      headRevision: "3",
      hasMore: false,
    };
    const replaced = published && applyCatalogChanges(published, delta);
    const fresh = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "3",
      cursor: "cursor-3",
      entries: [source, folder, renamed],
    });
    expect(replaced).toEqual(fresh);
    expect(replaced && applyCatalogChanges(replaced, delta)).toEqual(fresh);
    const deleted =
      replaced &&
      applyCatalogChanges(replaced, {
        kind: "delta",
        scope,
        commits: [
          {
            eventId: "event-4",
            commitId: "commit-4",
            firstRevision: "4",
            lastRevision: "4",
            changes: [
              { operation: "invalidate-subtree", ordinal: 0, rootEntryId: renamed.entryId },
            ],
          },
        ],
        nextCursor: "cursor-4",
        headRevision: "4",
        hasMore: false,
      });
    expect(deleted?.entries.has(renamed.entryId)).toBe(false);
    expect(deleted && catalogFiles(deleted)).toEqual([]);
    expect(initial.entries.has(stale.entryId)).toBe(true);
  });

  it("applies bounded pages without advancing applied revision to the observed head", () => {
    const initial = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "0",
      cursor: "cursor-0",
      entries: [source],
    });
    const page1 = applyCatalogChanges(initial, {
      kind: "delta",
      scope,
      commits: [
        { eventId: "e1", commitId: "c1", firstRevision: "1", lastRevision: "1", changes: [] },
      ],
      nextCursor: "cursor-1",
      headRevision: "2",
      hasMore: true,
    });
    expect(page1?.appliedRevision).toBe("1");
    expect(page1?.observedHeadRevision).toBe("2");
    const page2 =
      page1 &&
      applyCatalogChanges(page1, {
        kind: "delta",
        scope,
        commits: [
          { eventId: "e2", commitId: "c2", firstRevision: "2", lastRevision: "2", changes: [] },
        ],
        nextCursor: "cursor-2",
        headRevision: "2",
        hasMore: false,
      });
    expect(page2?.appliedRevision).toBe("2");
  });

  it("rejects a commit newer than the reported head without mutating the live view", () => {
    const initial = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source],
    });
    const result = applyCatalogChanges(initial, {
      kind: "delta",
      scope,
      commits: [
        { eventId: "e2", commitId: "c2", firstRevision: "2", lastRevision: "2", changes: [] },
      ],
      nextCursor: "cursor-2",
      headRevision: "1",
      hasMore: false,
    });
    expect(result).toBeNull();
    expect(initial.appliedRevision).toBe("1");
  });

  it("requests snapshot replacement on reset without mutating live state", () => {
    const before = catalogViewFromSnapshot({
      scope,
      generation: "generation-1",
      headRevision: "1",
      cursor: "cursor-1",
      entries: [source],
    });
    expect(
      applyCatalogChanges(before, { kind: "reset-required", scope, reason: "expired" }),
    ).toBeNull();
    expect(before.entries.size).toBe(1);
  });
});

{
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
          observationVersion: "1",
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
          observationVersion: "1",
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
      const stale = planCatalogInstallation({
        projectId,
        records: [current],
        view: view(),
      });
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
        planCatalogInstallation({
          projectId,
          records: [terminal],
          view: view(),
        }).resources,
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
        planCatalogInstallation({
          projectId,
          records: [current],
          view: view("document"),
        }).resources[0]?.next.resource,
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
      for (const uri of ["scratch://@w1/notes.md", "scratch://@x/"])
        expect(() =>
          planCatalogInstallation({
            projectId,
            records: [],
            view: scopedView(
              { kind: "lineage", projectId, rootThreadId: "root-id" },
              "scratch",
              uri,
            ),
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
        scope: { kind: "lineage", projectId, rootThreadId: "root-id" } as const,
        scheme: "scratch" as const,
        uri: "scratch://@c12/notes.md",
        expected: {
          scheme: "scratch",
          workId: null,
          rootThreadId: "root-id",
          rootThreadRef: "c12",
        },
      },
      {
        scope: { kind: "work", projectId, workId: "work-id" } as const,
        scheme: "scratch" as const,
        uri: "scratch://@w1/notes.md",
        expected: { scheme: "scratch", workId: "work-id", workHandle: "w1" },
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
}

{
  const view = () =>
    catalogViewFromSnapshot({
      scope: scopeFromNamespaceScheduleFixtures,
      generation: "g",
      headRevision: "1",
      cursor: "c",
      entries: entriesFromNamespaceScheduleFixtures,
    });

  it("retains command-free folder observations and their server parent IDs", () => {
    const writes = planFolderCatalogInstallation({
      projectId: "p",
      folders: [],
      view: view(),
      fence: {},
    });
    expect(writes).toHaveLength(3);
    for (const write of writes) validateFolderNamespaceUpdate(null, write.next);
    expect(writes.find((write) => write.next.folderId === "A")?.next).toMatchObject({
      handle: "folder:A",
      canonical: loc("P/A"),
      canonicalParent: { kind: "folder", folderId: "P" },
      intents: [],
    });
  });

  it("a late checkpoint cannot replace a newer exact parent at the same absolute home", () => {
    const folders = planFolderCatalogInstallation({
      projectId: "p",
      folders: [],
      view: view(),
      fence: {},
    }).map((write) => write.next);
    const fence = { folders: folderObservationFence(folders) };
    const current = folders.map((record) =>
      record.folderId === "A"
        ? {
            ...record,
            revision: record.revision + 1,
            canonicalParent: { kind: "folder" as const, folderId: "replacement-P" },
          }
        : record,
    );
    expect(
      planFolderCatalogInstallation({
        projectId: "p",
        folders: current,
        view: view(),
        fence,
      }),
    ).toEqual([]);
  });

  it("installs a newer server parent even when the absolute home has not changed", () => {
    const folders = planFolderCatalogInstallation({
      projectId: "p",
      folders: [],
      view: view(),
      fence: {},
    }).map((write) => write.next);
    const nextView = view();
    const entry = nextView.entries.get("A");
    if (entry?.kind !== "folder") throw new Error("Missing fixture folder");
    const updatedView = { ...nextView, entries: new Map(nextView.entries) };
    updatedView.entries.set("A", {
      ...entry,
      observationVersion: "2",
      parentId: "replacement-P",
    });
    const writes = planFolderCatalogInstallation({
      projectId: "p",
      folders,
      view: updatedView,
      fence: { folders: folderObservationFence(folders) },
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.next.canonicalParent).toEqual({ kind: "folder", folderId: "replacement-P" });
  });
}

{
  const projectId = "p";
  const scope = { kind: "project", projectId } as const;
  function folder(id: string, path: string, parentId: string, version: string): CatalogFolderEntry {
    return Object.assign(
      {
        observationVersion: "1",
        kind: "folder" as const,
        entryId: id,
        scope,
        sourceId: "source",
        parentId,
        name: path.split("/").at(-1)!,
        path: path.split("/"),
        uri: `manuscript://${path}` as const,
        hasChildren: false,
      },
      { observationVersion: version },
    );
  }
  const start: CatalogSnapshot = {
    scope,
    generation: "catalog-generation",
    headRevision: "1",
    cursor: "cursor-1",
    entries: [
      {
        kind: "source",
        entryId: "source",
        scope,
        scheme: "manuscript",
        name: "Manuscript",
        uri: "manuscript://",
      },
      folder("P", "P", "source", "1"),
      folder("Q", "Q", "source", "1"),
      folder("F", "Start", "source", "1"),
    ],
  };

  it.each([
    false,
    true,
  ])("older replay preserves newer canonical evidence (interrupted=%s)", async (interrupted) => {
    const view = catalogViewFromSnapshot(start);
    let folders = planFolderCatalogInstallation({ projectId, folders: [], view, fence: {} }).map(
      (w) => w.next,
    );
    const initial = folders.find((f) => f.folderId === "F")!;
    const refreshed = installFolderNamespaceAvailability(
      { ...initial, canonicalRefresh: { operationId: "move" } },
      "move",
      Object.assign(
        {
          observationVersion: "1",
          kind: "available" as const,
          location: {
            scheme: "manuscript" as const,
            workId: null,
            path: "/Q/Newest",
            name: "Newest",
          },
          parent: { kind: "folder" as const, folderId: "Q" },
        },
        { observationVersion: "3" },
      ),
    )!;
    folders = folders.map((f) => (f.folderId === "F" ? refreshed.next : f));
    let state: ResourceProjectionSnapshot = {
      records: [],
      folders,
      catalogs: [planCatalogInstallation({ projectId, records: [], view }).checkpoint],
    };
    const metadata = {
      accountId: "account",
      readProjection: async () => structuredClone(state),
      commitCatalog: async (input: Parameters<ResourceMetadataStore["commitCatalog"]>[0]) => {
        expect(state.catalogs[0]!.revision).toBe(input.expectedRevision);
        const byId = new Map(state.folders.map((f) => [f.handle, f]));
        for (const w of input.folders) byId.set(w.next.handle, w.next);
        state = { records: [], folders: [...byId.values()], catalogs: [input.next] };
        return "committed" as const;
      },
    } as unknown as ResourceMetadataStore;
    let requests = 0;
    const acquisition = new ResourceCatalogAcquisition("account", metadata, {
      accountId: "account",
      snapshot: async () => {
        throw new Error("Unexpected reset");
      },
      changes: async () => {
        if (requests++ && interrupted) throw new Error("Lost next page");
        return {
          kind: "delta",
          scope,
          commits: [
            {
              eventId: "event",
              commitId: "commit",
              firstRevision: requests === 1 ? "2" : "3",
              lastRevision: requests === 1 ? "2" : "3",
              changes: [
                {
                  operation: "upsert",
                  ordinal: 0,
                  entry:
                    requests === 1
                      ? folder("F", "P/Historical", "P", "2")
                      : folder("F", "Q/Newest", "Q", "3"),
                },
              ],
            },
          ],
          headRevision: "3",
          nextCursor: `cursor-${requests + 1}`,
          hasMore: requests === 1,
        };
      },
    });
    try {
      if (interrupted)
        await expect(acquisition.acquire(projectId, scope)).rejects.toThrow("Lost next page");
      else await acquisition.acquire(projectId, scope);
      expect(state.catalogs[0]!.appliedRevision).toBe(interrupted ? "2" : "3");
      expect(state.folders.find((f) => f.folderId === "F")).toMatchObject({
        canonical: { path: "/Q/Newest" },
        canonicalParent: { kind: "folder", folderId: "Q" },
        observationVersion: "3",
      });
    } finally {
      await acquisition.finishClose();
    }
  });

  it.each([
    "2",
    "3",
  ])("equal/older canonical observations are replay progress only (%s)", (version) => {
    const view = catalogViewFromSnapshot(start);
    const folders = planFolderCatalogInstallation({ projectId, folders: [], view, fence: {} }).map(
      (w) =>
        w.next.folderId === "F"
          ? Object.assign(w.next, {
              canonical: {
                scheme: "manuscript" as const,
                workId: null,
                path: "/Q/Newest",
                name: "Newest",
              },
              canonicalParent: { kind: "folder" as const, folderId: "Q" },
              observationVersion: "3",
            })
          : w.next,
    );
    const entries = new Map(view.entries);
    entries.set("F", folder("F", "P/Historical", "P", version));
    expect(
      planFolderCatalogInstallation({
        projectId,
        folders,
        view: { ...view, entries },
        fence: { folders: folderObservationFence(folders) },
      }),
    ).toEqual([]);
  });

  function document(): ResourceRecord {
    return {
      resource: {
        handle: "document",
        revision: 1,
        identity: { documentId: "D", revision: 1 },
        canonical: { scheme: "manuscript", workId: null, path: "/Q/Newest.md", name: "Newest.md" },
        canonicalParent: { kind: "folder", folderId: "Q" },
        observationVersion: "3",
        classification: { editable: true, filetype: "markdown", schemaType: "document" },
        content: { kind: "unacquired" },
        lifecycle: { kind: "acknowledged", availabilityGeneration: null },
        aliases: {},
        obligations: {},
      },
      intents: [],
    };
  }

  it.each([
    "2",
    "3",
    "4",
  ])("documents install location, parent and classification only for newer versions (%s)", (version) => {
    const record = document();
    const view = catalogViewFromSnapshot(start);
    const entries = new Map(view.entries);
    entries.set("D", {
      kind: "file",
      entryId: "D",
      scope,
      sourceId: "source",
      parentId: "P",
      name: "Historical.bin",
      path: ["P", "Historical.bin"],
      uri: "manuscript://P/Historical.bin",
      observationVersion: version,
      aliases: [],
      provisionalName: false,
      editable: false,
      disposition: "binary",
      fileType: "binary",
      mimeType: null,
    });
    const plan = planCatalogInstallation({
      projectId,
      records: [record],
      view: { ...view, entries },
      observedAfter: {
        resources: new Map([
          [
            "document",
            {
              revision: 1,
              canonical: record.resource.canonical,
              canonicalParent: record.resource.canonicalParent,
              classification: record.resource.classification,
            },
          ],
        ]),
      },
    });
    if (version === "4")
      expect(plan.resources[0]?.next.resource).toMatchObject({
        canonical: { path: "/P/Historical.bin" },
        canonicalParent: { folderId: "P" },
        classification: { editable: false },
        observationVersion: "4",
      });
    else expect(plan.resources).toEqual([]);
  });

  it("equal evidence clears a matching refresh without replacing the held canonical observation", () => {
    const record = document();
    record.resource.obligations.canonicalRefresh = {
      operationId: "move",
      identityRevision: 1,
      observationVersion: "3",
    };
    const available = {
      kind: "available" as const,
      observationVersion: "3",
      location: {
        scheme: "manuscript" as const,
        workId: null,
        path: "/P/Contradictory.md",
        name: "Contradictory.md",
      },
      parent: { kind: "folder" as const, folderId: "P" },
    };
    const write = installNamespaceAvailability(record, "move", available);
    expect(write?.next.resource.canonical).toEqual(record.resource.canonical);
    expect(write?.next.resource.canonicalParent).toEqual(record.resource.canonicalParent);
    expect(write?.next.resource.obligations.canonicalRefresh).toBeUndefined();
    expect(
      installNamespaceAvailability(record, "move", {
        ...available,
        observationVersion: "2",
      }),
    ).toBeNull();
    record.resource.obligations.canonicalRefresh.observationVersion = "4";
    expect(installNamespaceAvailability(record, "move", available)).toBeNull();
  });

  it("historical delete receipts cannot terminalize a newer canonical observation", () => {
    const record = document();
    expect(committedResourceDeletion(record.resource, "100", "delete", "2")).toEqual(
      record.resource,
    );
    expect(committedResourceDeletion(record.resource, "100", "delete", "3")).toEqual(
      record.resource,
    );
    expect(committedResourceDeletion(record.resource, "1", "delete", "4")).toMatchObject({
      canonical: null,
      observationVersion: "4",
      lifecycle: { kind: "terminal", generation: "1" },
    });
  });

  it("a newer intermediate observation updates canonical fields but cannot release a newer receipt fence", () => {
    const record = document();
    record.resource.observationVersion = "1";
    record.resource.obligations.canonicalRefresh = {
      operationId: "move",
      identityRevision: 1,
      observationVersion: "3",
    };
    const write = installNamespaceAvailability(record, "move", {
      kind: "available",
      observationVersion: "2",
      location: {
        scheme: "manuscript",
        workId: null,
        path: "/P/Intermediate.md",
        name: "Intermediate.md",
      },
      parent: { kind: "folder", folderId: "P" },
    });
    expect(write?.next.resource).toMatchObject({
      observationVersion: "2",
      canonical: { path: "/P/Intermediate.md" },
      obligations: { canonicalRefresh: { observationVersion: "3" } },
    });
  });
}
