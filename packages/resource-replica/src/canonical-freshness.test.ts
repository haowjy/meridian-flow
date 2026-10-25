/** Historical replay advances checkpoints without regressing exact-ID canonical evidence. */
import type { CatalogFolderEntry, CatalogSnapshot } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import { catalogViewFromSnapshot } from "./catalog";
import { ResourceCatalogAcquisition } from "./catalog-acquisition";
import { planCatalogInstallation } from "./catalog-installation";
import {
  folderObservationFence,
  planFolderCatalogInstallation,
} from "./folder-catalog-installation";
import { installFolderNamespaceAvailability } from "./folder-namespace";
import { committedResourceDeletion } from "./resource-deletion";
import { installNamespaceAvailability } from "./resource-namespace";
import type {
  ResourceMetadataStore,
  ResourceProjectionSnapshot,
  ResourceRecord,
} from "./resource-records";

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
      expect(state.catalogs[0]?.revision).toBe(input.expectedRevision);
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
    expect(state.catalogs[0]?.appliedRevision).toBe(interrupted ? "2" : "3");
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

    hasProperties: false,
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
    installNamespaceAvailability(record, "move", { ...available, observationVersion: "2" }),
  ).toBeNull();
  record.resource.obligations.canonicalRefresh.observationVersion = "4";
  expect(installNamespaceAvailability(record, "move", available)).toBeNull();
});

it("historical delete receipts cannot terminalize a newer canonical observation", () => {
  const record = document();
  expect(committedResourceDeletion(record.resource, "100", "delete", "2")).toEqual(record.resource);
  expect(committedResourceDeletion(record.resource, "100", "delete", "3")).toEqual(record.resource);
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
