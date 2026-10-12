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
import type { ResourceMetadataStore, ResourceProjectionSnapshot } from "./resource-records";

const projectId = "p";
const scope = { kind: "project", projectId } as const;
function folder(id: string, path: string, parentId: string, version: string): CatalogFolderEntry {
  return Object.assign(
    {
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
      view,
      fence: { folders: folderObservationFence(folders) },
    }),
  ).toEqual([]);
});
