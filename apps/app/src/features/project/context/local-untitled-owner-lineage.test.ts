import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { DocumentSession } from "@/core/editor/document-session";
import { BrowserLocalUntitledLineageLedger } from "./local-untitled-lineage-ledger";
import { LocalUntitledOwner } from "./local-untitled-owner";

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function leasePort() {
  return { tryAcquire: vi.fn(async () => ({ release: vi.fn(async () => undefined) })) };
}

it("owner remint uses one lineage commit and preserves the exact live session/provider", async () => {
  const storage = new MemoryStorage();
  const lifetime = leasePort();
  const owner = new LocalUntitledOwner({
    accountId: "account",
    ledger: new BrowserLocalUntitledLineageLedger(storage, lifetime),
    identityReservations: {
      tryReserve: async () => ({ kind: "reserved", release: async () => undefined }),
    },
    sessions: {
      createDetached: ({ documentId, persistenceKey }) =>
        new DocumentSession({
          roomKey: documentId,
          persistence: { kind: "indexeddb", key: persistenceKey },
        }),
    },
    reservations: { reserve: vi.fn(() => Object.freeze({}) as never), abort: vi.fn() },
    adoption: {
      begin: vi.fn(),
      abort: vi.fn(),
      inspect: vi.fn(async () => "clear" as const),
      recover: vi.fn(),
      bindAndAdopt: vi.fn(),
    },
    newLineageHandle: () => "L",
    newPersistenceId: () => "P",
    newObligationId: () => "obligation-A",
  });
  const a = owner.key("project", "A");
  const opened = await owner.create(a);
  if (opened.kind !== "opened") throw new Error("not opened");
  await opened.value.session.whenLocalPersistenceSynced();
  const before = {
    doc: opened.value.session.document,
    awareness: opened.value.session.awareness,
    provider: opened.value.session.localPersistenceProvider,
    name: opened.value.session.persistenceName,
  };
  const committed = await owner.remint(a, owner.key("project", "B"));
  expect(committed.value.session.document).toBe(before.doc);
  expect(committed.value.session.awareness).toBe(before.awareness);
  expect(committed.value.session.localPersistenceProvider).toBe(before.provider);
  expect(committed.value.session.persistenceName).toBe(before.name);
  expect(owner.listWork()[0]).toMatchObject({
    key: { documentId: "B" },
    ref: { lineageHandle: "L" },
  });
  const durable = [...storage.values.values()].map((raw) => JSON.parse(raw))[0];
  expect(durable).toMatchObject({
    active: { documentId: "B" },
    persistence: { persistenceId: "P", exactDatabaseName: before.name },
    aliases: { A: { publicationObligationId: "obligation-A" } },
  });
  await owner.destroyAll();
});
