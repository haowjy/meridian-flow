/** Content provenance is a committed snapshot, not successful replay of an empty cache. */
import "fake-indexeddb/auto";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { afterEach, expect, it, vi } from "vitest";
import { IndexeddbPersistence, storeState } from "y-indexeddb";
import * as Y from "yjs";
import { DocumentSession, deleteIndexedDb } from "./document-session";
import {
  commitContentInitialization,
  readContentInitialization,
} from "./local-content-initialization";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

async function cache(name = `initialization-${crypto.randomUUID()}`) {
  const document = new Y.Doc();
  const persistence = new IndexeddbPersistence(name, document);
  cleanup.push(async () => {
    await persistence.destroy();
    document.destroy();
  });
  await persistence.whenSynced;
  if (!persistence.db) throw new Error("Expected replayed database");
  return { document, persistence, database: persistence.db };
}

it("distinguishes committed empty initialization from a deleted and recreated cache", async () => {
  const first = await cache();
  expect(await readContentInitialization(first.database)).toBe(false);
  await commitContentInitialization(first.database, first.document);
  await first.persistence.destroy();
  const reopened = await cache(first.database.name);
  expect(await readContentInitialization(reopened.database)).toBe(true);
  expect(reopened.document.getText("writing").toString()).toBe("");
  await reopened.persistence.destroy();
  await deleteIndexedDb(first.database.name);
  const recreated = await cache(first.database.name);
  expect(await readContentInitialization(recreated.database)).toBe(false);
});

it("does not infer initialization from recoverable legacy writing", async () => {
  const legacy = await cache();
  legacy.document.getText("writing").insert(0, "legacy words");
  await legacy.persistence.destroy();
  const reopened = await cache(legacy.database.name);
  expect(reopened.document.getText("writing").toString()).toBe("legacy words");
  expect(await readContentInitialization(reopened.database)).toBe(false);
});

it("rolls the snapshot and marker back together after a successful put request", async () => {
  const target = await cache();
  const snapshot = new Y.Doc();
  snapshot.getText("writing").insert(0, "must roll back");
  const native = target.database.transaction.bind(target.database);
  vi.spyOn(target.database, "transaction").mockImplementation((...args) => {
    const transaction = native(...args);
    if (args[1] === "readwrite") {
      const store = transaction.objectStore("custom");
      const put = store.put.bind(store);
      vi.spyOn(store, "put").mockImplementation((...values) => {
        const request = put(...values);
        request.onsuccess = () => transaction.abort();
        return request;
      });
    }
    return transaction;
  });
  await expect(commitContentInitialization(target.database, snapshot)).rejects.toThrow();
  vi.restoreAllMocks();
  await target.persistence.destroy();
  const reopened = await cache(target.database.name);
  expect(await readContentInitialization(reopened.database)).toBe(false);
  expect(reopened.document.getText("writing").toString()).toBe("");
  snapshot.destroy();
});

it.each([
  { database: "other-incarnation" },
  { schema: "old-schema" },
  { version: 2 },
])("rejects mismatched initialization evidence: %j", async (marker) => {
  const target = await cache();
  await new Promise<void>((resolve, reject) => {
    const transaction = target.database.transaction("custom", "readwrite");
    transaction
      .objectStore("custom")
      .put(
        { version: 1, database: target.database.name, schema: collabSchemaKeyTag(), ...marker },
        "meridian:content-initialization",
      );
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  expect(await readContentInitialization(target.database)).toBe(false);
});

it("preserves concurrent writing through initialization and compaction", async () => {
  const left = await cache();
  const right = await cache(left.database.name);
  left.document.getText("writing").insert(0, "left");
  right.document.getText("writing").insert(0, "right");
  await Promise.all([
    commitContentInitialization(left.database, left.document),
    commitContentInitialization(right.database, right.document),
    storeState(left.persistence),
  ]);
  await left.persistence.destroy();
  await right.persistence.destroy();
  const reopened = await cache(left.database.name);
  expect(await readContentInitialization(reopened.database)).toBe(true);
  expect(reopened.document.getText("writing").toString()).toContain("left");
  expect(reopened.document.getText("writing").toString()).toContain("right");
});

it("requires an actual completed server reconciliation for existing content", async () => {
  let synced!: () => void;
  const whenSynced = new Promise<void>((resolve) => {
    synced = resolve;
  });
  const existing = new DocumentSession({
    roomKey: "C",
    persistence: { kind: "indexeddb", key: crypto.randomUUID() },
    transportFactory: () => ({ whenSynced, destroy() {} }),
  });
  cleanup.push(() => existing.destroy());
  expect(await existing.hasInitializedLocalContent()).toBe(false);
  synced();
  await existing.whenSynced();
  expect(await existing.hasInitializedLocalContent()).toBe(true);
});

it("an absent transport sync promise is not initialization proof", async () => {
  const session = new DocumentSession({
    roomKey: "D",
    persistence: { kind: "indexeddb", key: crypto.randomUUID() },
    transportFactory: () => ({ destroy() {} }),
  });
  cleanup.push(() => session.destroy());
  await session.whenSynced();
  expect(await session.hasInitializedLocalContent()).toBe(false);
});

it("does not establish fresh proof after a schema fence", async () => {
  const session = new DocumentSession({
    roomKey: "fenced",
    persistence: { kind: "indexeddb", key: crypto.randomUUID(), fresh: true },
  });
  cleanup.push(() => session.destroy());
  session.raiseSchemaFence({ reason: "client-superseded" });
  expect(await session.hasInitializedLocalContent()).toBe(false);
});

it("drains an admitted initialization transaction before destroying persistence", async () => {
  const name = crypto.randomUUID();
  const session = new DocumentSession({
    roomKey: "drain",
    persistence: { kind: "indexeddb", key: name },
  });
  cleanup.push(() => session.destroy());
  await session.whenLocalPersistenceSynced();
  const database = (session.localPersistenceProvider as IndexeddbPersistence).db;
  if (!database) throw new Error("Expected persistence");
  const native = database.transaction.bind(database);
  const order: string[] = [];
  let closing!: Promise<void>;
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(database, "transaction").mockImplementation((...args) => {
    const transaction = native(...args);
    if (args[1] === "readwrite") {
      transaction.addEventListener("complete", () => order.push("commit"));
      queueMicrotask(() => {
        closing = session.destroy().then(() => {
          order.push("destroyed");
        });
        started();
      });
    }
    return transaction;
  });
  session.attachTransport(() => ({ whenSynced: Promise.resolve(), destroy() {} }));
  await admitted;
  await closing;
  expect(order).toEqual(["commit", "destroyed"]);
  const reopened = await cache(name);
  expect(await readContentInitialization(reopened.database)).toBe(true);
});

it("reads another participant's committed proof after its own failed initialization", async () => {
  const session = new DocumentSession({
    roomKey: "retry",
    persistence: { kind: "indexeddb", key: crypto.randomUUID() },
  });
  cleanup.push(() => session.destroy());
  await session.whenLocalPersistenceSynced();
  const database = (session.localPersistenceProvider as IndexeddbPersistence).db;
  if (!database) throw new Error("Expected persistence");
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  const native = database.transaction.bind(database);
  vi.spyOn(database, "transaction").mockImplementation((...args) => {
    if (args[1] === "readwrite") throw new DOMException("quota", "QuotaExceededError");
    return native(...args);
  });
  session.attachTransport(() => ({ whenSynced: Promise.resolve(), destroy() {} }));
  await session.whenSynced();
  expect(await session.hasInitializedLocalContent()).toBe(false);
  expect(report).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
  await commitContentInitialization(database, session.document);
  expect(await session.hasInitializedLocalContent()).toBe(true);
  vi.unstubAllGlobals();
});
