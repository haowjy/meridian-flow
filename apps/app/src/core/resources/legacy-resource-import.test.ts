/** Legacy handoff preserves exact content identity and uncertainty across interrupted imports. */
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, expect, it, vi } from "vitest";
import type { RoomOrderRecord } from "../editor/document-session-authority-store";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import { importLegacyResources, resolveLegacyResources } from "./legacy-resource-import";
import { type LegacyResourceRecord, snapshotLegacyResources } from "./legacy-resource-record";

const accountId = "import/account";
const stores: IndexedDbResourceMetadata[] = [];
function open() {
  const store = new IndexedDbResourceMetadata(accountId, vi.fn());
  stores.push(store);
  return store;
}
const authority = {
  accountId,
  readRoom: vi.fn(
    async (documentId: string): Promise<RoomOrderRecord> => ({
      documentId,
      persistence: null,
      documentAdmittedThrough: null,
      pendingDrain: null,
    }),
  ),
};
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.finishClose()));
  await Dexie.delete(`meridian:resource-metadata:v1:${encodeURIComponent(accountId)}`);
  vi.restoreAllMocks();
});
function local(handle = "lineage"): LegacyResourceRecord {
  return {
    version: 4,
    kind: "local",
    envelopeRevision: 3,
    ref: { accountId, projectId: "project", lineageHandle: handle },
    active: { documentId: handle, identityRevision: 2 },
    persistence: { persistenceId: "opaque", exactDatabaseName: `original-cache:${handle}` },
    work: {
      workRevision: 1,
      home: { scheme: "unfiled", folderPath: "/drafts" },
      createSettlement: { kind: "ready" },
      pendingSinceMs: 1,
    },
    aliases: {},
  };
}
function bytes(record: LegacyResourceRecord) {
  return {
    sourceKey: `meridian:local-untitled-lineage:v3:${[record.ref.accountId, record.ref.projectId, record.ref.lineageHandle].map(encodeURIComponent).join(":")}`,
    raw: JSON.stringify(record),
  };
}

it("imports exact persistence without inventing initialization proof and resumes after a committed prefix", async () => {
  const first = open();
  const source = [bytes(local("one")), bytes(local("two"))];
  const commit = first.commitMigration.bind(first);
  vi.spyOn(first, "commitMigration")
    .mockImplementationOnce(commit)
    .mockRejectedValueOnce(new Error("interrupted"));
  await expect(
    importLegacyResources({ accountId, source, authority, metadata: first }),
  ).rejects.toThrow("interrupted");
  expect((await first.readMigration()).evidence).toHaveLength(1);
  await first.finishClose();
  const restarted = open();
  await importLegacyResources({ accountId, source, authority, metadata: restarted });
  expect((await restarted.readMigration()).checkpoint?.state).toBe("complete");
  const record = await restarted.readResource({ projectId: "project", handle: "one" });
  expect(record?.resource.content).toEqual({
    kind: "exact",
    databaseName: "original-cache:one",
    schema: null,
  });
  expect(record?.intents).toMatchObject([
    { state: "pending", attempts: [], desired: { kind: "create", folderPath: "/drafts" } },
  ]);
  await importLegacyResources({ accountId, source, authority, metadata: restarted });
  expect((await restarted.readMigration()).evidence).toHaveLength(2);
});

it("preserves malformed and wrong-account bytes rather than creating blank resources", async () => {
  const metadata = open();
  const wrongAccount = local("foreign");
  wrongAccount.ref.accountId = "different-account";
  const source = [{ ...bytes(local()), raw: "{broken" }, bytes(wrongAccount)];
  await importLegacyResources({ accountId, source, authority, metadata });
  expect((await metadata.readMigration()).evidence).toEqual(
    source
      .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
      .map((item) => ({
        ...item,
        status: "recovery",
        reason: "Unsupported or malformed legacy record",
      })),
  );
  expect(await metadata.readResource({ projectId: "project", handle: "lineage" })).toBeNull();
});

it("recovers adopted persistence only from matching committed authority", async () => {
  const metadata = open();
  const original = local();
  if (original.kind !== "local") throw new Error("fixture");
  const { persistence: _persistence, ...base } = original;
  const adopted: LegacyResourceRecord = {
    ...base,
    kind: "adopted",
    adoptionRevision: 3,
    canonicalSync: {
      kind: "canonical-sync",
      obligationId: "sync",
      documentId: "lineage",
      adoptionRevision: 3,
    },
  };
  const readRoom = vi.fn(
    async (documentId: string): Promise<RoomOrderRecord> => ({
      documentId,
      persistence: {
        phase: "bindable",
        generation: "1",
        exactDatabaseName: "proven-original-cache",
        originLineageHandle: "lineage",
      },
      documentAdmittedThrough: "1",
      pendingDrain: null,
    }),
  );
  await importLegacyResources({
    accountId,
    source: [bytes(adopted)],
    authority: { accountId, readRoom },
    metadata,
  });
  const record = await metadata.readResource({ projectId: "project", handle: "lineage" });
  expect(record?.resource.content).toMatchObject({
    databaseName: "proven-original-cache",
    schema: null,
  });
  expect(record?.resource.obligations.canonicalSync?.obligationId).toBe("sync");
});

it("preserves legacy settlements for resolution without fabricating attempt or canonical authority", async () => {
  const metadata = open();
  const record = local();
  if (record.kind !== "local") throw new Error("fixture");
  record.work.createSettlement = { kind: "confirmation-required" };
  await importLegacyResources({ accountId, source: [bytes(record)], authority, metadata });
  expect(
    (await metadata.readResource({ projectId: "project", handle: "lineage" }))?.resource,
  ).toMatchObject({
    content: { kind: "exact", databaseName: "original-cache:lineage", schema: null },
    recovery: { sourceKey: bytes(record).sourceKey },
    lifecycle: { kind: "local" },
  });
  const current = await metadata.readResource({ projectId: "project", handle: "lineage" });
  if (!current) throw new Error("fixture missing");
  const next = {
    resource: { ...current.resource, revision: 2 },
    intents: [
      {
        projectId: "project",
        handle: "lineage",
        intentId: "writer-placement",
        sequence: 1,
        identityRevision: 2,
        desired: {
          kind: "set-location" as const,
          destination: {
            scheme: "manuscript" as const,
            folderPath: "",
            name: "New title",
            workId: null,
          },
        },
        attempts: [],
        state: "pending" as const,
      },
    ],
  };
  expect(await metadata.commitResource({ expectedRevision: 1, next })).toBe("committed");
  await resolveLegacyResources({ accountId, authority, metadata });
  expect(await metadata.readResource({ projectId: "project", handle: "lineage" })).toEqual(next);
  expect((await metadata.readMigration()).checkpoint?.state).toBe("complete");
  expect((await metadata.readMigration()).evidence[0]).toMatchObject({
    raw: bytes(record).raw,
    status: "recovery",
  });
});

it("revisits recovery evidence when authority becomes bindable without replacing raw bytes", async () => {
  const metadata = open();
  const record = local();
  if (record.kind !== "local") throw new Error("fixture");
  const { persistence: _persistence, ...base } = record;
  const adopted: LegacyResourceRecord = { ...base, kind: "adopted", adoptionRevision: 2 };
  const source = [bytes(adopted)];
  await importLegacyResources({ accountId, source, authority, metadata });
  expect((await metadata.readMigration()).checkpoint?.state).toBe("complete");
  const ready = {
    accountId,
    readRoom: async (documentId: string): Promise<RoomOrderRecord> => ({
      documentId,
      persistence: {
        phase: "bindable",
        generation: "1",
        exactDatabaseName: "original",
        originLineageHandle: "lineage",
      },
      documentAdmittedThrough: "1",
      pendingDrain: null,
    }),
  };
  const captured = await metadata.readResource({ projectId: "project", handle: "lineage" });
  if (!captured) throw new Error("fixture missing");
  const intention = {
    projectId: "project",
    handle: "lineage",
    intentId: "new-placement",
    sequence: 1,
    identityRevision: 2,
    desired: {
      kind: "set-location" as const,
      destination: {
        scheme: "manuscript" as const,
        folderPath: "",
        name: "Writer title",
        workId: null,
      },
    },
    attempts: [],
    state: "pending" as const,
  };
  await metadata.commitResource({
    expectedRevision: 1,
    next: {
      resource: {
        ...captured.resource,
        canonical: { scheme: "manuscript", path: "new", name: "new", workId: null },
        aliases: {
          previous: { publicationObligationId: "publish", introducedAtIdentityRevision: 1 },
        },
        revision: 2,
        content: {
          kind: "exact",
          databaseName: "original",
          schema: "verified-schema",
        },
      },
      intents: [intention],
    },
  });
  await resolveLegacyResources({ accountId, authority: ready, metadata });
  const resolved = await metadata.readResource({ projectId: "project", handle: "lineage" });
  expect(resolved?.intents).toEqual([intention]);
  expect(resolved?.resource.content).toEqual({
    kind: "exact",
    databaseName: "original",
    schema: "verified-schema",
  });
  expect(resolved?.resource.recovery).toBeUndefined();
  expect(resolved?.resource.canonical?.path).toBe("new");
  expect(resolved?.resource.aliases).toEqual({
    previous: {
      publicationObligationId: "publish",
      introducedAtIdentityRevision: 1,
    },
  });
  expect(
    (await metadata.readResource({ projectId: "project", handle: "lineage" }))?.resource.revision,
  ).toBe(3);
  expect((await metadata.readMigration()).checkpoint?.state).toBe("complete");
  expect((await metadata.readMigration()).evidence).toEqual([{ ...source[0], status: "imported" }]);
});

it("snapshots all raw keys for one account including undecodable values", () => {
  const raw = new Map([
    [bytes(local()).sourceKey, "broken"],
    ["meridian:local-untitled-lineage:v3:other:project:doc", "foreign"],
  ]);
  const storage = {
    length: raw.size,
    key: (index: number) => [...raw.keys()][index] ?? null,
    getItem: (key: string) => raw.get(key) ?? null,
  } as Storage;
  expect(snapshotLegacyResources(accountId, storage)).toEqual([
    { sourceKey: bytes(local()).sourceKey, raw: "broken" },
  ]);
});

it("does not infer terminal cleanup completion from missing or conflicting room authority", async () => {
  const metadata = open();
  const terminal: LegacyResourceRecord = {
    version: 4,
    kind: "terminal",
    envelopeRevision: 5,
    ref: { accountId, projectId: "project", lineageHandle: "terminal" },
    documentId: "doc",
    exactDatabaseName: "original",
    terminalGeneration: "2",
    transitionId: "transition",
    cleanupObligationId: "cleanup",
  };
  const source = [bytes(terminal)];
  expect(await importLegacyResources({ accountId, source, authority, metadata })).toBe(
    "recovery-required",
  );
  const conflicting = {
    accountId,
    readRoom: async (documentId: string): Promise<RoomOrderRecord> => ({
      documentId,
      persistence: { phase: "bindable", generation: "3", exactDatabaseName: "new-incarnation" },
      documentAdmittedThrough: "3",
      pendingDrain: null,
    }),
  };
  await resolveLegacyResources({ accountId, authority: conflicting, metadata });
  expect(
    (await metadata.readResource({ projectId: "project", handle: "terminal" }))?.resource,
  ).toMatchObject({
    lifecycle: { kind: "terminal", generation: "2" },
    content: { kind: "unacquired" },
    recovery: { sourceKey: source[0].sourceKey },
    obligations: {},
  });
  const placeholder = await metadata.readResource({ projectId: "project", handle: "terminal" });
  if (!placeholder) throw new Error("fixture missing");
  await expect(
    metadata.commitResource({
      expectedRevision: 1,
      next: {
        ...placeholder,
        resource: { ...placeholder.resource, revision: 2, lifecycle: { kind: "recovering" } },
      },
    }),
  ).rejects.toThrow("Terminal resources cannot be revived");
  const matching = {
    accountId,
    readRoom: async (documentId: string): Promise<RoomOrderRecord> => ({
      documentId,
      persistence: {
        phase: "terminal-local",
        terminalGeneration: "2",
        transitionId: "transition",
        lineageHandle: "terminal",
        exactDatabaseName: "original",
        commandId: "command",
      },
      documentAdmittedThrough: "2",
      pendingDrain: null,
    }),
  };
  await resolveLegacyResources({ accountId, authority: matching, metadata });
  expect(
    (await metadata.readResource({ projectId: "project", handle: "terminal" }))?.resource
      .obligations.cleanup,
  ).toEqual({ obligationId: "cleanup", exactDatabaseName: "original" });
});

it("rejects a different destination account before reading or writing migration data", async () => {
  const metadata = open();
  const read = vi.spyOn(metadata, "readMigration");
  await expect(
    importLegacyResources({
      accountId: "other",
      source: [],
      authority: { ...authority, accountId: "other" },
      metadata,
    }),
  ).rejects.toThrow("Legacy import account mismatch");
  expect(read).not.toHaveBeenCalled();
});

it("publishes recovery placeholders and preserves them when resolution loses a revision race", async () => {
  const metadata = open();
  const original = local();
  if (original.kind !== "local") throw new Error("fixture");
  const { persistence: _persistence, ...base } = original;
  const adopted: LegacyResourceRecord = { ...base, kind: "adopted", adoptionRevision: 2 };
  const observed = vi.fn();
  const stop = metadata.observeProject("project", observed, (error) => {
    throw error;
  });
  try {
    await importLegacyResources({ accountId, source: [bytes(adopted)], authority, metadata });
    await vi.waitFor(() =>
      expect(observed).toHaveBeenLastCalledWith(
        expect.objectContaining({
          records: [
            expect.objectContaining({
              resource: expect.objectContaining({ lifecycle: { kind: "recovering" } }),
            }),
          ],
        }),
      ),
    );
    const key = { projectId: "project", handle: "lineage" };
    const readRoom = async (documentId: string): Promise<RoomOrderRecord> => {
      const current = await metadata.readResource(key);
      if (!current) throw new Error("fixture missing");
      await metadata.commitResource({
        expectedRevision: current.resource.revision,
        next: {
          ...current,
          resource: { ...current.resource, revision: current.resource.revision + 1 },
        },
      });
      return {
        documentId,
        persistence: {
          phase: "bindable",
          generation: "1",
          exactDatabaseName: "original",
          originLineageHandle: "lineage",
        },
        documentAdmittedThrough: "1",
        pendingDrain: null,
      };
    };
    await resolveLegacyResources({ accountId, authority: { accountId, readRoom }, metadata });
    expect((await metadata.readResource(key))?.resource).toMatchObject({
      revision: 2,
      lifecycle: { kind: "recovering" },
    });
    expect((await metadata.readMigration()).evidence[0]?.status).toBe("recovery");
    const current = await metadata.readResource(key);
    if (!current) throw new Error("fixture missing");
    await metadata.commitResource({
      expectedRevision: 2,
      next: {
        ...current,
        resource: {
          ...current.resource,
          revision: 3,
          recovery: { sourceKey: "different-source" },
        },
      },
    });
    const untouchedAuthority = vi.fn(readRoom);
    await resolveLegacyResources({
      accountId,
      authority: { accountId, readRoom: untouchedAuthority },
      metadata,
    });
    expect(untouchedAuthority).not.toHaveBeenCalled();
    expect((await metadata.readMigration()).evidence[0]?.status).toBe("recovery");
  } finally {
    stop();
  }
});
