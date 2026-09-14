/** Storage conformance: atomic visibility, durable attempts, isolated accounts and shutdown. */
import "fake-indexeddb/auto";
import type { ResourceRecord, ResourceWrite } from "@meridian/resource-replica";
import Dexie from "dexie";
import { afterEach, expect, it, vi } from "vitest";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";

const stores: IndexedDbResourceMetadata[] = [];
const accounts = new Set<string>();
function open(account = crypto.randomUUID(), versionChanged = vi.fn()) {
  accounts.add(account);
  const store = new IndexedDbResourceMetadata(account, versionChanged);
  stores.push(store);
  return store;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.finishClose()));
  for (const account of accounts)
    await Dexie.delete(`meridian:resource-metadata:v1:${encodeURIComponent(account)}`);
  accounts.clear();
});

function resource(handle = "doc", revision = 1): ResourceRecord {
  return {
    resource: {
      projectId: "project",
      handle,
      revision,
      identity: { documentId: handle, revision: 1 },
      content: { kind: "exact", databaseName: `exact:${handle}`, schema: "0.5" },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: {},
    },
    intents: [
      {
        projectId: "project",
        handle,
        intentId: `create-${handle}`,
        sequence: 1,
        identityRevision: 1,
        desired: { kind: "create", folderPath: "" },
        attempts: [],
        state: "pending",
      },
    ],
  };
}

it("preserves a committed reservation across shutdown and isolates identical handles by account", async () => {
  const account = crypto.randomUUID();
  const first = open(account);
  const next = resource();
  expect(await first.commitResource({ expectedRevision: null, next })).toBe("committed");
  await first.finishClose();
  expect(await open(account).readResource(next.resource)).toEqual(next);
  expect(await open().readResource(next.resource)).toBeNull();
});

it("serializes competing revisions without losing or partially publishing the loser", async () => {
  const account = crypto.randomUUID();
  const left = open(account);
  const right = open(account);
  await left.commitResource({ expectedRevision: null, next: resource() });
  const a = resource("doc", 2);
  const b = resource("doc", 2);
  a.resource.canonical = { scheme: "unfiled", path: "/A", name: "A", workId: null };
  b.resource.canonical = { scheme: "unfiled", path: "/B", name: "B", workId: null };
  const results = await Promise.all([
    left.commitResource({ expectedRevision: 1, next: a }),
    right.commitResource({ expectedRevision: 1, next: b }),
  ]);
  expect(results.sort()).toEqual(["committed", "stale"]);
  expect(await left.readResource(a.resource)).toEqual(await right.readResource(a.resource));
  expect((await left.readResource(a.resource))?.resource.revision).toBe(2);
});

it("rolls back resource, intent, raw evidence and migration checkpoint on outer abort", async () => {
  const store = open();
  const native = Dexie.prototype.transaction;
  vi.spyOn(Dexie.prototype, "transaction").mockImplementation(function (
    this: Dexie,
    ...args: Parameters<typeof native>
  ) {
    const callback = args.pop() as () => Promise<unknown>;
    return Reflect.apply(native, this, [
      ...args,
      async () => {
        await callback();
        throw new Error("injected outer abort");
      },
    ]);
  });
  await expect(
    store.commitMigration({
      expectedRevision: null,
      next: { revision: 1, state: "importing" },
      resources: [{ expectedRevision: null, next: resource() }],
      evidence: [{ sourceKey: "legacy", raw: "unparseable bytes", status: "recovery" }],
    }),
  ).rejects.toThrow("injected outer abort");
  vi.restoreAllMocks();
  expect(await store.readResource({ projectId: "project", handle: "doc" })).toBeNull();
  expect(await store.readMigration()).toEqual({ checkpoint: null, evidence: [] });
});

it("keeps catalog entries and cursor unchanged when a resource revision is stale", async () => {
  const store = open();
  const scope = { kind: "project" as const, projectId: "project" };
  const checkpoint = {
    projectId: "project",
    scope,
    revision: 1,
    generation: "generation",
    appliedRevision: "1",
    observedHeadRevision: "1",
    cursor: "cursor-1",
    entries: [],
    invalidatedEntryIds: [],
  };
  expect(
    await store.commitCatalog({
      expectedRevision: null,
      next: checkpoint,
      resources: [{ expectedRevision: null, next: resource() }],
    }),
  ).toBe("committed");
  expect(
    await store.commitCatalog({
      expectedRevision: 1,
      next: { ...checkpoint, revision: 2, cursor: "cursor-2" },
      resources: [{ expectedRevision: null, next: resource("doc", 2) }],
    }),
  ).toBe("stale");
  expect(await store.readCatalog("project", scope)).toEqual(checkpoint);
  expect(await store.readProject("project")).toEqual({
    records: [resource()],
    catalogs: [checkpoint],
  });
});

it("retains submitted request bytes and rejects replacement by a later intention", async () => {
  const store = open();
  const next = resource();
  const intent = next.intents[0];
  next.intents = [
    {
      ...intent,
      state: "submitted",
      attempts: [
        {
          attemptId: "attempt",
          request: { kind: "create", body: { documentId: "doc", folderPath: "" } },
        },
      ],
    },
  ];
  await store.commitResource({ expectedRevision: null, next });
  const replacement = structuredClone(next);
  replacement.resource.revision = 2;
  replacement.intents[0].attempts[0].request = { kind: "create", body: { documentId: "other" } };
  await expect(store.commitResource({ expectedRevision: 1, next: replacement })).rejects.toThrow(
    "Submitted namespace request cannot be replaced",
  );
  expect(await store.readResource(next.resource)).toEqual(next);
});

it("commits migration evidence and resumes from the stored checkpoint", async () => {
  const account = crypto.randomUUID();
  const store = open(account);
  const batch = {
    expectedRevision: null,
    next: { revision: 1, state: "importing" as const },
    evidence: [{ sourceKey: "broken-record", raw: "{not-json", status: "recovery" as const }],
    resources: [{ expectedRevision: null, next: resource() }],
  };
  await store.commitMigration(batch);
  await store.finishClose();
  const restored = open(account);
  expect(await restored.readMigration()).toEqual({
    checkpoint: batch.next,
    evidence: batch.evidence,
  });
  expect(await restored.commitMigration(batch)).toBe("stale");
  expect(await restored.readResource(batch.resources[0].next.resource)).toEqual(
    batch.resources[0].next,
  );
});

it("observes committed records across instances and stops admission before draining", async () => {
  const account = crypto.randomUUID();
  const left = open(account);
  const right = open(account);
  const observed: readonly ResourceRecord[][] = [];
  const errors = vi.fn();
  const stop = right.observeProject(
    "project",
    ({ records }) => (observed as ResourceRecord[][]).push([...records]),
    errors,
  );
  await left.commitResource({ expectedRevision: null, next: resource() });
  await vi.waitFor(() =>
    expect(observed.some((records) => records[0]?.resource.revision === 1)).toBe(true),
  );
  stop();
  const write: ResourceWrite = { expectedRevision: 1, next: resource("doc", 2) };
  const admitted = left.commitResource(write);
  left.beginClose();
  await expect(left.commitResource(write)).rejects.toThrow("closing");
  await left.finishClose();
  expect(await admitted).toBe("committed");
  expect((await right.readResource(write.next.resource))?.resource.revision).toBe(2);
  expect(errors).not.toHaveBeenCalled();
});

it("snapshots an admitted write before the caller can mutate it", async () => {
  const store = open();
  const next = resource();
  const admitted = store.commitResource({ expectedRevision: null, next });
  next.resource.canonical = { scheme: "unfiled", path: "/changed", name: "changed", workId: null };
  await admitted;
  expect((await store.readResource(next.resource))?.resource.canonical).toBeNull();
});

it("rejects retroactive intention order and settled-work replay", async () => {
  const store = open();
  const next = resource();
  next.intents = [{ ...next.intents[0], sequence: 2 }];
  await store.commitResource({ expectedRevision: null, next });
  const retroactive = structuredClone(next);
  retroactive.resource.revision = 2;
  retroactive.intents = [
    ...retroactive.intents,
    { ...retroactive.intents[0], intentId: "earlier", sequence: 1 },
  ];
  await expect(store.commitResource({ expectedRevision: 1, next: retroactive })).rejects.toThrow(
    "follow recorded history",
  );
  const settled = structuredClone(next);
  settled.resource.revision = 2;
  settled.intents = [
    {
      ...settled.intents[0],
      state: "settled",
      attempts: [
        {
          attemptId: "done",
          request: { kind: "create", body: { documentId: "doc" } },
          outcome: {
            kind: "create",
            result: {
              status: "created",
              documentId: "doc",
              scheme: "unfiled",
              path: "/doc",
              name: "doc",
            },
          },
        },
      ],
    },
  ];
  await store.commitResource({ expectedRevision: 1, next: settled });
  const replay = structuredClone(settled);
  replay.resource.revision = 3;
  replay.intents[0].state = "needs-repair";
  await expect(store.commitResource({ expectedRevision: 2, next: replay })).rejects.toThrow(
    "cannot restart",
  );
});

it("preserves raw migration evidence and never restarts a completed import", async () => {
  const store = open();
  const evidence = [{ sourceKey: "legacy", raw: "ORIGINAL", status: "recovery" as const }];
  await store.commitMigration({
    expectedRevision: null,
    next: { revision: 1, state: "importing" },
    resources: [],
    evidence,
  });
  await expect(
    store.commitMigration({
      expectedRevision: 1,
      next: { revision: 2, state: "importing" },
      resources: [],
      evidence: [{ ...evidence[0], raw: "REPLACED" }],
    }),
  ).rejects.toThrow("cannot be replaced");
  await store.commitMigration({
    expectedRevision: 1,
    next: { revision: 2, state: "complete" },
    resources: [],
    evidence: [],
  });
  await expect(
    store.commitMigration({
      expectedRevision: 2,
      next: { revision: 3, state: "importing" },
      resources: [],
      evidence: [],
    }),
  ).rejects.toThrow("cannot restart");
  expect(await store.readMigration()).toEqual({
    checkpoint: { revision: 2, state: "complete" },
    evidence,
  });
});

it("notifies project observers after a catalog-only commit", async () => {
  const store = open();
  const observed: string[] = [];
  const onError = vi.fn();
  store.observeProject(
    "project",
    ({ catalogs }) => {
      for (const catalog of catalogs) observed.push(catalog.cursor);
    },
    onError,
  );
  await store.commitCatalog({
    expectedRevision: null,
    next: {
      projectId: "project",
      scope: { kind: "project", projectId: "project" },
      revision: 1,
      generation: "g",
      appliedRevision: "1",
      observedHeadRevision: "1",
      cursor: "new-catalog",
      entries: [],
      invalidatedEntryIds: [],
    },
    resources: [],
  });
  await vi.waitFor(() => expect(observed).toContain("new-catalog"));
  expect(onError).not.toHaveBeenCalled();
});

it("resolves captured recovery atomically without reopening capture or replacing evidence", async () => {
  const store = open();
  const raw = "preserved legacy bytes";
  await store.commitMigration({
    expectedRevision: null,
    next: { revision: 1, state: "complete" },
    resources: [],
    evidence: [{ sourceKey: "legacy", raw, status: "recovery" }],
  });
  const command = {
    sourceKey: "legacy",
    expectedRaw: raw,
    resource: { expectedRevision: null, next: resource() },
  };
  expect(await store.resolveMigrationEvidence({ ...command, expectedRaw: "different" })).toBe(
    "stale",
  );
  expect(await store.readResource(command.resource.next.resource)).toBeNull();
  const native = Dexie.prototype.transaction;
  vi.spyOn(Dexie.prototype, "transaction").mockImplementationOnce(function (
    this: Dexie,
    ...args: Parameters<typeof native>
  ) {
    const callback = args.pop() as () => Promise<unknown>;
    return Reflect.apply(native, this, [
      ...args,
      async () => {
        await callback();
        throw new Error("resolution abort");
      },
    ]);
  });
  await expect(store.resolveMigrationEvidence(command)).rejects.toThrow("resolution abort");
  expect(await store.readResource(command.resource.next.resource)).toBeNull();
  expect((await store.readMigration()).evidence[0]?.status).toBe("recovery");
  expect(
    (
      await Promise.all([
        store.resolveMigrationEvidence(command),
        store.resolveMigrationEvidence(command),
      ])
    ).sort(),
  ).toEqual(["committed", "stale"]);
  expect(await store.readMigration()).toEqual({
    checkpoint: { revision: 1, state: "complete" },
    evidence: [{ sourceKey: "legacy", raw, status: "imported" }],
  });
});
