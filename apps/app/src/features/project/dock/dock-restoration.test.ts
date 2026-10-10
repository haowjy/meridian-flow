/** Dock reload contracts: durable layout, hydrated identity, scope, and newer intent. */
import {
  emptyCatalogView,
  type ResourceProjectionSnapshot,
  type ResourceRecord,
} from "@meridian/resource-replica";
import { beforeEach, expect, it, vi } from "vitest";
import type { ContextTab } from "@/client/stores";
import { listed } from "@/test-support/draft-review-scope";
import {
  createDockDocumentStore,
  type DockDocument,
  dockDocumentFitsScope,
} from "./dock-document-store";
import { DOCK_STORAGE_KEY, type DockStorage } from "./dock-persistence";
import { restoreDockDocument } from "./restore-dock-document";

const availability = vi.hoisted(() => vi.fn());
vi.mock("@/client/query/project-context-availability", () => ({
  lookupProjectContextAvailability: availability,
}));
beforeEach(() => availability.mockReset());
const tab: ContextTab = {
  kind: "tracked",
  documentId: "doc",
  tabInstanceId: "instance",
  name: "Old.md",
  scheme: "manuscript",
  path: "/Old.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};
const document: DockDocument = {
  projectId: "project",
  screen: "chat",
  screenWorkId: null,
  tab,
  review: null,
};
function storage(): DockStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
function reload(occupant = document) {
  const disk = storage();
  const first = createDockDocumentStore(() => disk, "account");
  if (occupant.screen === "work")
    first.getState().syncOccupantScope("project", "work", occupant.screenWorkId);
  first.getState().commit(first.getState().claim(), occupant);
  return createDockDocumentStore(() => disk, "account");
}
const renamedAvailability = {
  resolutions: [
    {
      kind: "available",
      documentId: "doc",
      authority: { kind: "project", projectId: "project" },
      entry: {
        kind: "file",
        entryId: "doc",
        editable: true,
        schemaType: "document",
        name: "New.md",
        path: ["New.md"],
        uri: "manuscript://New.md",
        filetype: "markdown",
      },
    },
  ],
};
const empty: ResourceProjectionSnapshot = { records: [], folders: [], catalogs: [] };
function resources(snapshot = empty) {
  return {
    readWorkDrafts: vi.fn(async () => []),
    resources: {
      readProjection: vi.fn(async () => snapshot),
      acquireCatalog: vi.fn(async () =>
        emptyCatalogView({ kind: "project", projectId: "project" }),
      ),
    },
  };
}
function localRecord(): ResourceRecord {
  return {
    resource: {
      handle: "local",
      revision: 1,
      identity: { documentId: "doc", revision: 1 },
      content: { kind: "exact", databaseName: "local", schema: null },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: {},
    },
    intents: [
      {
        projectId: "project",
        handle: "local",
        intentId: "create",
        sequence: 1,
        identityRevision: 1,
        desired: { kind: "create", folderPath: "" },
        attempts: [],
        state: "pending",
      },
    ],
  };
}
it("round-trips the account-stamped document in a fresh store", () => {
  const second = reload();
  const restored = second.getState().restoring;
  if (!restored) throw new Error("Expected a restore candidate");
  expect(restored).toEqual(document);
  expect(second.getState().occupant).toBeNull();
  const revision = second.getState().revision;
  second.getState().restore(restored, restored);
  expect(second.getState().occupant).toEqual(document);
  expect(second.getState().revision).toBe(revision);
});
it("does not restore a Work document onto another Work or project", () => {
  const workDocument: DockDocument = {
    ...document,
    screen: "work",
    screenWorkId: "work",
    tab: { ...tab, scheme: "scratch", workId: "work" },
  };
  const same = reload(workDocument);
  same.getState().syncOccupantScope("project", "work", "work");
  expect(same.getState().restoring).toEqual(workDocument);
  same.getState().syncOccupantScope("project", "work", "other");
  expect(same.getState().restoring).toBeNull();
  const other = reload();
  other.getState().syncOccupantScope("other-project", "chat", null);
  expect(other.getState().restoring).toBeNull();
});
it("rechecks the Work fence when validation moves a note to another Work", () => {
  const second = reload({
    ...document,
    screen: "work",
    screenWorkId: "work",
    tab: { ...tab, scheme: "scratch", workId: "work" },
  });
  second.getState().syncOccupantScope("project", "work", "work");
  const restored = second.getState().restoring;
  if (!restored) throw new Error("Expected a restore candidate");
  second
    .getState()
    .restore(restored, { ...restored, tab: { ...tab, scheme: "scratch", workId: "other" } });
  expect(second.getState().occupant).toBeNull();
});
it("a pick during replica hydration wins without the restore cancelling its claim", async () => {
  const second = reload();
  const restored = second.getState().restoring;
  if (!restored) throw new Error("Expected a restore candidate");
  let hydrate!: (snapshot: ResourceProjectionSnapshot) => void;
  const pending = restoreDockDocument(restored, {
    ...resources(),
    resources: {
      ...resources().resources,
      readProjection: () =>
        new Promise((resolve) => {
          hydrate = resolve;
        }),
    },
  });
  expect(second.getState().occupant).toBeNull();
  const claim = second.getState().claim();
  const picked: DockDocument = { ...document, tab: { ...tab, documentId: "picked" } };
  availability.mockResolvedValue({ resolutions: [{ kind: "not-visible", documentId: "doc" }] });
  hydrate(empty);
  second.getState().restore(restored, await pending);
  expect(second.getState().isCurrent(claim)).toBe(true);
  expect(second.getState().commit(claim, picked)).toBe(true);
  expect(second.getState().occupant).toEqual(picked);
});
it("a removed document restores as nothing", async () => {
  availability.mockResolvedValue({ resolutions: [{ kind: "deleted", documentId: "doc" }] });
  const second = reload();
  const restored = second.getState().restoring;
  if (!restored) throw new Error("Expected a restore candidate");
  second.getState().restore(restored, await restoreDockDocument(restored, resources()));
  expect(second.getState().occupant).toBeNull();
});
it("a terminal replica document restores as nothing without acquiring it", async () => {
  const record = localRecord();
  record.resource.lifecycle = { kind: "terminal", generation: "1", transitionId: "delete" };
  const restored = await restoreDockDocument(
    { ...document, tab: { ...tab, resourceHandle: "local" } },
    resources({ ...empty, records: [record] }),
  );
  expect(restored).toBeNull();
});
it("Untitled restores only while its hydrated local resource exists", async () => {
  const untitled: DockDocument = {
    ...document,
    tab: { kind: "new", documentId: "doc", name: "Untitled", resourceHandle: "local" },
  };
  expect(await restoreDockDocument(untitled, resources())).toBeNull();
  expect(
    await restoreDockDocument(untitled, resources({ ...empty, records: [localRecord()] })),
  ).toMatchObject({ tab: { kind: "new", resourceHandle: "local" } });
});
it("throwing storage getters, reads and writes leave the live dock usable", () => {
  for (const disk of [
    () => {
      throw new Error("disabled");
    },
    () => ({
      getItem: () => null,
      setItem: () => {
        throw new Error("write");
      },
    }),
    () => ({
      getItem: () => {
        throw new Error("read");
      },
      setItem: () => {
        throw new Error("write");
      },
    }),
  ]) {
    const store = createDockDocumentStore(disk, "account");
    expect(store.getState().restoring).toBeNull();
    expect(store.getState().commit(store.getState().claim(), document)).toBe(true);
    expect(store.getState().occupant).toEqual(document);
  }
});
it.each([
  "{",
  '{"version":2,"accountId":"account"}',
  '{"version":1,"accountId":"account","occupant":{"projectId":"project","screen":"context","tab":{}}}',
])("ignores invalid storage: %s", (raw) => {
  const disk = storage();
  disk.setItem(DOCK_STORAGE_KEY, raw);
  expect(createDockDocumentStore(() => disk, "account").getState().restoring).toBeNull();
});
it("reloads the production singleton with its saved document", async () => {
  vi.stubGlobal("window", { sessionStorage: storage() });
  try {
    vi.resetModules();
    const first = (await import("./dock-document-store")).useDockDocumentStore;
    first.getState().rehydrate("account");
    first.getState().commit(first.getState().claim(), document);
    vi.resetModules();
    const second = (await import("./dock-document-store")).useDockDocumentStore;
    second.getState().rehydrate("account");
    expect(second.getState().restoring).toEqual(document);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

it.each([
  { projectId: "project", screen: "work", workId: "work", stays: true },
  { projectId: "project", screen: "work", workId: "other", stays: false },
  { projectId: "project", screen: "chat", workId: "work", stays: false },
  { projectId: "other", screen: "work", workId: "work", stays: false },
] as const)("one Work scope rule: $projectId/$screen/$workId", ({ stays, ...scope }) => {
  const note: DockDocument = {
    ...document,
    screen: "work",
    screenWorkId: "work",
    tab: { ...tab, scheme: "scratch", workId: "work" },
  };
  const manuscript = {
    ...document,
    screen: "work" as const,
    screenWorkId: "work",
    review: { workId: "work", draftId: "draft" },
  };
  const restored = reload(manuscript);
  restored.getState().syncOccupantScope(scope.projectId, scope.screen, scope.workId);
  expect(restored.getState().restoring).toEqual(stays ? manuscript : null);
  expect(dockDocumentFitsScope(note, scope)).toBe(stays);
  expect(dockDocumentFitsScope(document, scope)).toBe(scope.projectId === "project");
});
it("does not restore another account's resource handles", () => {
  const disk = storage();
  const first = createDockDocumentStore(() => disk, "account-a");
  first.getState().commit(first.getState().claim(), document);
  const second = createDockDocumentStore(() => disk, "account-b");
  expect(second.getState().restoring).toBeNull();
});
it("stamps the snapshot and makes same-account hydration idempotent", () => {
  const disk = storage();
  const store = createDockDocumentStore(() => disk, "account");
  store.getState().commit(store.getState().claim(), document);
  expect(JSON.parse(disk.getItem(DOCK_STORAGE_KEY) ?? "null").accountId).toBe("account");
  const revision = store.getState().revision;
  store.getState().rehydrate("account");
  expect(store.getState().occupant).toEqual(document);
  expect(store.getState().revision).toBe(revision);
});
it("account changes clear live state and invalidate the previous account's claim", () => {
  const disk = storage();
  const store = createDockDocumentStore(() => disk, "account-a");
  store.getState().commit(store.getState().claim(), document);
  const claim = store.getState().claim();
  store.getState().rehydrate("account-b");
  expect(store.getState().occupant).toBeNull();
  expect(store.getState().restoring).toBeNull();
  expect(store.getState().commit(claim, document)).toBe(false);
});
it("rejects an unstamped snapshot instead of assigning its resource handles to the current account", () => {
  const disk = storage();
  disk.setItem(DOCK_STORAGE_KEY, JSON.stringify({ version: 1, occupant: document }));
  const store = createDockDocumentStore(() => disk, "account");
  expect(store.getState().restoring).toBeNull();
});
it("deferred account hydration obeys the scope already synced by the shell without claiming", () => {
  const disk = storage();
  const first = createDockDocumentStore(() => disk, "account");
  first.getState().commit(first.getState().claim(), document);
  const second = createDockDocumentStore(() => disk);
  second.getState().syncOccupantScope("other-project", "chat", null);
  const revision = second.getState().revision;
  second.getState().rehydrate("account");
  expect(second.getState().restoring).toBeNull();
  expect(second.getState().revision).toBe(revision);
});
it.each([
  { screen: ["work"] },
  { review: undefined },
  { review: {} },
  { review: { workId: "", draftId: "draft" } },
])("rejects malformed occupant identity: %o", (invalid) => {
  const disk = storage();
  disk.setItem(
    DOCK_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      accountId: "account",
      occupant: { ...document, ...invalid },
    }),
  );
  expect(createDockDocumentStore(() => disk, "account").getState().restoring).toBeNull();
});

it("reloads a draft-only review from its Work list, without catalog membership", async () => {
  const review = { workId: "work", draftId: "draft" };
  const second = reload({
    ...document,
    review,
    tab: {
      ...tab,
      draftOnly: true,
      reviewWorkId: "work",
      reviewDraftId: "draft",
      tabInstanceToken: "old",
    },
  });
  const candidate = second.getState().restoring!;
  const replica = resources();
  const restored = await restoreDockDocument(candidate, {
    ...replica,
    resources: replica.resources,
    readWorkDrafts: async () => [
      {
        ...listed,
        documentId: "doc",
        draftId: "draft",
        isNewDocument: true,
        contextPath: "/Current.md",
      },
    ],
  });
  expect(replica.resources.readProjection).not.toHaveBeenCalled();
  await expect(
    restoreDockDocument(candidate, {
      ...replica,
      readWorkDrafts: async () => {
        throw new Error("offline");
      },
    }),
  ).rejects.toThrow("offline");
  expect(restored).toMatchObject({
    review,
    tab: {
      documentId: "doc",
      draftOnly: true,
      reviewWorkId: "work",
      reviewDraftId: "draft",
      path: "/Current.md",
    },
  });
});
it("keeps a manuscript review while validating its renamed live identity", async () => {
  availability.mockResolvedValue(renamedAvailability);
  const review = { workId: "work", draftId: "draft" };
  const replica = resources();
  const restored = await restoreDockDocument(
    { ...document, review },
    {
      ...replica,
      resources: replica.resources,
      readWorkDrafts: async () => [
        { ...listed, documentId: "doc", draftId: "draft", isNewDocument: false },
      ],
    },
  );
  expect(restored).toMatchObject({ review, tab: { documentId: "doc", path: "/New.md" } });
  expect(await restoreDockDocument({ ...document, review }, replica)).toMatchObject({
    review: null,
    tab: { documentId: "doc", path: "/New.md" },
  });
  availability.mockResolvedValue({ resolutions: [{ kind: "deleted", documentId: "doc" }] });
  expect(await restoreDockDocument({ ...document, review }, replica)).toBeNull();
});
