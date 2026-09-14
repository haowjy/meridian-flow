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
  for (const account of accounts) {
    await Promise.all([
      Dexie.delete(`meridian:resource-metadata:v1:${encodeURIComponent(account)}`),
      Dexie.delete(`meridian:resource-metadata:v2:${encodeURIComponent(account)}`),
    ]);
  }
  accounts.clear();
});

function resource(handle = "doc", revision = 1): ResourceRecord {
  return {
    resource: {
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

it("uses a fresh physical database instead of opening the incompatible dormant schema", async () => {
  const account = crypto.randomUUID();
  accounts.add(account);
  const legacy = new Dexie(`meridian:resource-metadata:v1:${encodeURIComponent(account)}`);
  legacy.version(1).stores({
    resources: "[projectId+handle],projectId",
    intents: "[projectId+intentId],[projectId+handle]",
    catalogs: "key,projectId",
    evidence: "sourceKey",
    checkpoints: "key",
  });
  await legacy.open();
  await legacy.table("resources").put({ ...resource().resource, projectId: "project" });
  legacy.close();

  const store = open(account);
  expect(
    await store.commitResource({ expectedRevision: null, next: resource("new-resource") }),
  ).toBe("committed");
  expect((await store.readProject("project")).records).toEqual([resource("new-resource")]);
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

it("rejects duplicate current document identities atomically", async () => {
  const store = open();
  expect(await store.commitResource({ expectedRevision: null, next: resource("first") })).toBe(
    "committed",
  );
  const duplicate = resource("second");
  duplicate.resource.identity = { documentId: "first", revision: 1 };

  expect(await store.commitResource({ expectedRevision: null, next: duplicate })).toBe("stale");
  expect(await store.readResource({ handle: "second" })).toBeNull();
});

it("rolls back resource, intent, and checkpoint writes when the outer transaction aborts", async () => {
  const store = open();
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
        throw new Error("injected outer abort");
      },
    ]);
  });
  const scope = { kind: "project" as const, projectId: "project" };

  await expect(
    store.commitCatalog({
      expectedRevision: null,
      next: {
        projectId: "project",
        scope,
        revision: 1,
        generation: "generation",
        appliedRevision: "1",
        observedHeadRevision: "1",
        cursor: "cursor",
        entries: [],
        invalidatedEntryIds: [],
      },
      resources: [{ expectedRevision: null, next: resource() }],
    }),
  ).rejects.toThrow("injected outer abort");
  vi.restoreAllMocks();
  expect(await store.readResource({ handle: "doc" })).toBeNull();
  expect(await store.readCatalog("project", scope)).toBeNull();
  const internals = store as unknown as { intents: { toArray(): Promise<unknown[]> } };
  expect(await internals.intents.toArray()).toEqual([]);
});

it("shares one account resource while qualifying the User catalog per consuming project", async () => {
  const store = open();
  const responseScope = { kind: "user" as const, userId: "account-user" };
  const first = {
    projectId: "project-a",
    scope: responseScope,
    revision: 1,
    generation: "generation",
    appliedRevision: "1",
    observedHeadRevision: "1",
    cursor: "cursor-a",
    entries: [],
    invalidatedEntryIds: [],
  };
  expect(
    await store.commitCatalog({
      expectedRevision: null,
      next: first,
      resources: [{ expectedRevision: null, next: resource() }],
    }),
  ).toBe("committed");
  const second = { ...first, projectId: "project-b", cursor: "cursor-b" };
  expect(await store.commitCatalog({ expectedRevision: null, next: second, resources: [] })).toBe(
    "committed",
  );

  const requestScope = { kind: "user" as const, userId: "self" };
  expect(await store.readCatalog("project-a", requestScope)).toEqual(first);
  expect(await store.readCatalog("project-b", requestScope)).toEqual(second);
  expect((await store.readProject("project-a")).records).toEqual([resource()]);
  expect((await store.readProject("project-b")).records).toEqual([resource()]);
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

it("rejects rewriting the project authority of recorded namespace work", async () => {
  const store = open();
  const next = resource();
  expect(await store.commitResource({ expectedRevision: null, next })).toBe("committed");
  const replacement = structuredClone(next);
  replacement.resource.revision = 2;
  replacement.intents[0].projectId = "other-project";

  await expect(store.commitResource({ expectedRevision: 1, next: replacement })).rejects.toThrow(
    "cannot be replaced",
  );
  expect(await store.readResource(next.resource)).toEqual(next);
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
