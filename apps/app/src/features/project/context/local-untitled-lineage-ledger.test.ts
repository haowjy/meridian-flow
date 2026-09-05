import { describe, expect, it, vi } from "vitest";
import type { LocalUntitledCrossContextLeasePort } from "@/core/editor/document-session-cross-context-coordination";
import type { LocalLineageEnvelope } from "./local-untitled-lineage";
import { BrowserLocalUntitledLineageLedger } from "./local-untitled-lineage-ledger";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  failWrites = false;
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
    if (this.failWrites) throw new Error("remove failed");
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("write failed");
    this.values.set(key, value);
  }
}

const ref = { accountId: "account", projectId: "project", lineageHandle: "lineage" };
function lineage(): LocalLineageEnvelope {
  return {
    version: 3,
    kind: "local",
    ref,
    envelopeRevision: 1,
    active: { documentId: "A", identityRevision: 1 },
    persistence: { persistenceId: "p", exactDatabaseName: "exact-p" },
    work: {
      workRevision: 1,
      home: null,
      createSettlement: { kind: "ready" },
      pendingSinceMs: null,
    },
    aliases: {},
  };
}

function lifetime(): LocalUntitledCrossContextLeasePort {
  return { tryAcquire: vi.fn(async () => ({ release: vi.fn(async () => undefined) })) };
}

describe("browser local Untitled lineage ledger", () => {
  it("performs one storage write for a remint old/new commit", async () => {
    const storage = new MemoryStorage();
    const set = vi.spyOn(storage, "setItem");
    const ledger = new BrowserLocalUntitledLineageLedger(storage, lifetime());
    const acquired = await ledger.acquire(ref);
    if (acquired.kind !== "acquired") throw new Error("not acquired");
    acquired.access.apply({ kind: "create-lineage", lineage: lineage() });
    set.mockClear();
    acquired.access.apply({
      kind: "commit-remint",
      expectedIdentityRevision: 1,
      replacementDocumentId: "B",
      publicationObligationId: "pub-A",
    });
    expect(set).toHaveBeenCalledTimes(1);
    expect(acquired.access.snapshot()).toMatchObject({
      active: { documentId: "B" },
      aliases: { A: { publicationObligationId: "pub-A" } },
      persistence: { exactDatabaseName: "exact-p" },
    });
  });

  it("leaves the previous envelope authoritative when storage throws", async () => {
    const storage = new MemoryStorage();
    const ledger = new BrowserLocalUntitledLineageLedger(storage, lifetime());
    const acquired = await ledger.acquire(ref);
    if (acquired.kind !== "acquired") throw new Error("not acquired");
    acquired.access.apply({ kind: "create-lineage", lineage: lineage() });
    storage.failWrites = true;
    expect(() =>
      acquired.access.apply({
        kind: "commit-remint",
        expectedIdentityRevision: 1,
        replacementDocumentId: "B",
        publicationObligationId: "pub-A",
      }),
    ).toThrow("write failed");
    storage.failWrites = false;
    const after = acquired.access.snapshot();
    expect(after?.kind === "local" && after.active.documentId).toBe("A");
  });

  it("ignores v2 residue rather than parsing or migrating it", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "meridian:pending-untitled:v2:account:project:A",
      JSON.stringify({ version: 2 }),
    );
    expect(new BrowserLocalUntitledLineageLedger(storage, lifetime()).list("account")).toEqual([]);
  });
});
