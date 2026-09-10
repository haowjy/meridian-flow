import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { DocumentSessionAuthorityStore } from "./document-session-authority-store";

function openMarked(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("marker");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function wasDeleted(name: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let upgraded = false;
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      upgraded = true;
    };
    request.onsuccess = () => {
      request.result.close();
      resolve(upgraded);
    };
    request.onerror = () => reject(request.error);
  });
}

describe("document authority lineage persistence", () => {
  it("keeps adopting-local non-bindable then finalizes the same exact P", async () => {
    const store = new DocumentSessionAuthorityStore("account-adoption");
    const pending = await store.beginLocalAdoption({
      documentId: "doc",
      transitionId: "T",
      lineageHandle: "L",
      exactDatabaseName: "exact-P",
      targetGeneration: null,
    });
    await expect(
      store.admit({ documentId: "doc", projectId: "project", generation: "3" }),
    ).resolves.toEqual({
      kind: "pending-local-adoption",
      phase: "adopting-local",
    });
    const bound = await store.bindLocalAdoptionGeneration({ ...pending, targetGeneration: "3" });
    await expect(store.finalizeLocalAdoption({ ...bound, targetGeneration: "3" })).resolves.toEqual(
      {
        kind: "admitted",
        persistenceGeneration: "3",
        exactDatabaseName: "exact-P",
      },
    );
    await store.admit({ documentId: "doc", projectId: "second-project", generation: "4" });
    await expect(store.readRoom("doc")).resolves.toMatchObject({
      persistence: {
        phase: "bindable",
        generation: "3",
        exactDatabaseName: "exact-P",
        originLineageHandle: "L",
      },
    });
    await store.close();
  });

  it("preserves an indeterminate reservation until exact abort", async () => {
    const store = new DocumentSessionAuthorityStore("account-indeterminate");
    const pending = await store.beginLocalAdoption({
      documentId: "doc",
      transitionId: "T",
      lineageHandle: "L",
      exactDatabaseName: "exact-P",
      targetGeneration: null,
    });
    await expect(store.readRoom("doc")).resolves.toMatchObject({
      persistence: { phase: "adopting-local", transitionId: "T" },
    });
    await expect(
      store.beginLocalAdoption({ ...pending, transitionId: "replacement-attempt" }),
    ).resolves.toEqual(pending);
    await expect(store.abortLocalAdoption({ ...pending, transitionId: "other" })).resolves.toBe(
      "stale",
    );
    await expect(store.abortLocalAdoption(pending)).resolves.toBe("aborted");
    await expect(store.readRoom("doc")).resolves.toMatchObject({ persistence: null });
    await store.close();
  });

  it("terminalizes before exact purge and leaves an unrelated database untouched", async () => {
    const accountId = "account-terminal";
    const store = new DocumentSessionAuthorityStore(accountId);
    const exact = "exact-terminal-P";
    const unrelated = "unrelated-database";
    (await openMarked(exact)).close();
    (await openMarked(unrelated)).close();
    const pending = await store.beginLocalAdoption({
      documentId: "doc",
      transitionId: "adopt",
      lineageHandle: "L",
      exactDatabaseName: exact,
      targetGeneration: null,
    });
    const bound = await store.bindLocalAdoptionGeneration({ ...pending, targetGeneration: "4" });
    await store.finalizeLocalAdoption({ ...bound, targetGeneration: "4" });
    const receipt = await store.startDocumentDrain({
      documentId: "doc",
      generation: "5",
      commandId: "delete-5",
    });
    expect(receipt.kind).toBe("lineage-transition-required");
    if (receipt.kind !== "lineage-transition-required") return;
    expect(receipt.persistenceGeneration).toBe("4");
    await expect(store.readRoom("doc")).resolves.toMatchObject({
      persistence: { phase: "terminal-local", exactDatabaseName: exact },
      pendingDrain: {
        generation: "5",
        incarnation: { generation: "4", exactDatabaseName: exact },
      },
    });
    await store.finishDocumentDrain({ documentId: "doc", generation: "5", commandId: "delete-5" });
    const purge = await store.snapshotPurge("doc");
    expect(purge?.exactDatabaseName).toBe(exact);
    if (!purge) return;
    expect(await store.deletePersistence(purge)).toBe(true);
    expect(await store.finishTerminalLineage(receipt)).toBe(true);
    expect(await wasDeleted(exact)).toBe(true);
    expect(await wasDeleted(unrelated)).toBe(false);
    await store.close();
  });

  it("rejects a stale terminal command without terminalizing newer lineage persistence", async () => {
    const store = new DocumentSessionAuthorityStore("account-stale-terminal");
    const pending = await store.beginLocalAdoption({
      documentId: "doc",
      transitionId: "adopt",
      lineageHandle: "L",
      exactDatabaseName: "exact-P5",
      targetGeneration: null,
    });
    const bound = await store.bindLocalAdoptionGeneration({ ...pending, targetGeneration: "5" });
    await store.finalizeLocalAdoption({ ...bound, targetGeneration: "5" });

    await expect(
      store.startDocumentDrain({
        documentId: "doc",
        generation: "4",
        commandId: "delete-4",
      }),
    ).resolves.toEqual({ kind: "older", revokedThrough: "5" });
    await expect(store.readRoom("doc")).resolves.toMatchObject({
      persistence: {
        phase: "bindable",
        generation: "5",
        exactDatabaseName: "exact-P5",
      },
      pendingDrain: null,
    });
    await expect(store.pendingPurges()).resolves.toEqual([]);
    await store.close();
  });

  it("retains exact P when terminalizing an adoption before generation binding", async () => {
    const store = new DocumentSessionAuthorityStore("account-unbound-terminal");
    await store.beginLocalAdoption({
      documentId: "doc",
      transitionId: "adopt",
      lineageHandle: "L",
      exactDatabaseName: "exact-unbound-P",
      targetGeneration: null,
    });

    const receipt = await store.startDocumentDrain({
      documentId: "doc",
      generation: "5",
      commandId: "delete-5",
    });
    expect(receipt.kind).toBe("lineage-transition-required");
    if (receipt.kind !== "lineage-transition-required") return;
    await expect(store.readRoom("doc")).resolves.toMatchObject({
      pendingDrain: { incarnation: { exactDatabaseName: "exact-unbound-P", generation: null } },
    });
    await store.finishDocumentDrain({
      documentId: "doc",
      generation: "5",
      commandId: "delete-5",
    });
    await expect(store.snapshotPurge("doc")).resolves.toMatchObject({
      exactDatabaseName: "exact-unbound-P",
      transitionId: receipt.transitionId,
    });
    await store.close();
  });
});
