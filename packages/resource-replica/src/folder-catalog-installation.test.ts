/** Parent provenance is installed atomically and guarded by the observation's revision. */
import { expect, it } from "vitest";
import { catalogViewFromSnapshot } from "./catalog";
import {
  folderObservationFence,
  planFolderCatalogInstallation,
} from "./folder-catalog-installation";
import { validateFolderNamespaceUpdate } from "./folder-namespace";
import { entries, loc, scope } from "./namespace-schedule-fixtures";

const view = () =>
  catalogViewFromSnapshot({ scope, generation: "g", headRevision: "1", cursor: "c", entries });

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
    planFolderCatalogInstallation({ projectId: "p", folders: current, view: view(), fence }),
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
  updatedView.entries.set("A", { ...entry, observationVersion: "2", parentId: "replacement-P" });
  const writes = planFolderCatalogInstallation({
    projectId: "p",
    folders,
    view: updatedView,
    fence: { folders: folderObservationFence(folders) },
  });
  expect(writes).toHaveLength(1);
  expect(writes[0]?.next.canonicalParent).toEqual({ kind: "folder", folderId: "replacement-P" });
});
