/**
 * Regression: a server-phase admission must stamp the resource lineage onto its
 * bindable authority. Without the stamp, a later cached open reads the record as
 * a foreign lineage ("mismatch"), adoption throws, and the Yjs transport never
 * attaches — the writer's prose silently persists only to y-indexeddb.
 */
import "fake-indexeddb/auto";
import { afterEach, expect, it } from "vitest";
import type { CrossContextLockManager } from "../cross-context-locks";
import { DocumentSessionAuthorityStore } from "./document-session-authority-store";
import type { LocalSessionAuthority } from "./document-session-coordination-contract";
import { createDocumentSessionCrossContextCoordination } from "./document-session-cross-context-coordination";
import { DocumentSessionRegistry } from "./document-session-registry-implementation";

const projectId = "project-1";
const documentId = "document-1";
const generation = "118";
const lineageHandle = "catalog:document-1";

function memoryLocks(): CrossContextLockManager {
  return {
    request: async (_name, _options, callback) => callback({}),
  };
}

function localAuthority(): LocalSessionAuthority {
  return {
    beginCloseAccountRuntime: () => undefined,
    validateAdmission: () => undefined,
    installSynchronously: () => undefined,
    drainDocument: async () => undefined,
    drainAccess: async () => "locally-empty",
    invalidateAll: async () => undefined,
  };
}

let accountSequence = 0;
const accounts = new Set<string>();

function nextAccount(): string {
  const accountId = `doc-session-lineage-${++accountSequence}`;
  accounts.add(accountId);
  return accountId;
}

function authorityDatabaseName(accountId: string): string {
  return `meridian:document-session-authority:${encodeURIComponent(accountId)}`;
}

async function persistedAuthority(
  store: DocumentSessionAuthorityStore,
): Promise<{ phase: string | undefined; originLineageHandle: string | undefined }> {
  const persistence = (await store.readRoom(documentId)).persistence;
  return {
    phase: persistence?.phase,
    originLineageHandle:
      persistence?.phase === "bindable" ? persistence.originLineageHandle : undefined,
  };
}

afterEach(() => {
  for (const account of accounts) indexedDB.deleteDatabase(authorityDatabaseName(account));
  accounts.clear();
});

it("stamps the server-phase bindable authority with its resource lineage", async () => {
  const accountId = nextAccount();
  const coordination = createDocumentSessionCrossContextCoordination({
    accountId,
    local: localAuthority(),
    locks: memoryLocks(),
    secureContext: true,
    createWakeChannel: null,
    reconcileIntervalMs: 60_000,
  });
  const store = new DocumentSessionAuthorityStore(accountId);
  try {
    const lease = await coordination.admit(projectId, documentId, generation, lineageHandle);
    expect(await persistedAuthority(store)).toEqual({
      phase: "bindable",
      originLineageHandle: lineageHandle,
    });
    await expect(
      coordination.inspectLocalLineage({
        documentId,
        lineageHandle,
        exactDatabaseName: lease.exactDatabaseName,
      }),
    ).resolves.toBe("bindable");
  } finally {
    await coordination.close();
    await store.close();
  }
});

it("resolves the lineage from its connected local resources before admitting", async () => {
  const accountId = nextAccount();
  const registry = new DocumentSessionRegistry(
    (id, local) =>
      createDocumentSessionCrossContextCoordination({
        accountId: id,
        local,
        locks: memoryLocks(),
        secureContext: true,
        createWakeChannel: null,
        reconcileIntervalMs: 60_000,
      }),
    undefined,
    accountId,
  );
  const store = new DocumentSessionAuthorityStore(accountId);
  try {
    registry.connectLocalResources({
      terminal: { continueTerminal: async () => "completed" },
      lineageHandleFor: async () => lineageHandle,
      beginClose: () => undefined,
      finishClose: async () => undefined,
    });
    await registry.admit(projectId, documentId, generation);
    expect(await persistedAuthority(store)).toEqual({
      phase: "bindable",
      originLineageHandle: lineageHandle,
    });
  } finally {
    await registry.closeAccountRuntime();
    await store.close();
  }
});

it("still rejects a genuinely different lineage", async () => {
  const accountId = nextAccount();
  const coordination = createDocumentSessionCrossContextCoordination({
    accountId,
    local: localAuthority(),
    locks: memoryLocks(),
    secureContext: true,
    createWakeChannel: null,
    reconcileIntervalMs: 60_000,
  });
  try {
    const lease = await coordination.admit(projectId, documentId, generation, lineageHandle);
    await expect(
      coordination.inspectLocalLineage({
        documentId,
        lineageHandle: "catalog:someone-else",
        exactDatabaseName: lease.exactDatabaseName,
      }),
    ).resolves.toBe("mismatch");
  } finally {
    await coordination.close();
  }
});

it("claims an exact legacy handle-less authority during cached-session recovery", async () => {
  const accountId = nextAccount();
  const store = new DocumentSessionAuthorityStore(accountId);
  const installed: Array<{ exactDatabaseName: string }> = [];
  const coordination = createDocumentSessionCrossContextCoordination({
    accountId,
    local: {
      ...localAuthority(),
      installSynchronously: (input) => installed.push(input),
    },
    locks: memoryLocks(),
    secureContext: true,
    createWakeChannel: null,
    reconcileIntervalMs: 60_000,
  });
  try {
    const admitted = await store.admit({ documentId, projectId, generation });
    if (admitted.kind !== "admitted") throw new Error("Expected legacy authority admission");

    await expect(
      coordination.inspectLocalLineage({
        documentId,
        lineageHandle,
        exactDatabaseName: admitted.exactDatabaseName,
      }),
    ).resolves.toBe("bindable");
    await expect(
      coordination.inspectLocalLineage({
        documentId,
        lineageHandle,
        exactDatabaseName: `${admitted.exactDatabaseName}:foreign`,
      }),
    ).resolves.toBe("mismatch");
    await expect(
      coordination.recoverLocalAdoption(
        projectId,
        documentId,
        generation,
        lineageHandle,
        `${admitted.exactDatabaseName}:foreign`,
      ),
    ).rejects.toThrow("Local adoption persistence authority belongs to another database");
    expect(await persistedAuthority(store)).toEqual({
      phase: "bindable",
      originLineageHandle: undefined,
    });
    await expect(
      coordination.recoverLocalAdoption(
        projectId,
        documentId,
        "119",
        lineageHandle,
        admitted.exactDatabaseName,
      ),
    ).rejects.toThrow("Local adoption recovery generation is stale");
    expect(await persistedAuthority(store)).toEqual({
      phase: "bindable",
      originLineageHandle: undefined,
    });

    await coordination.recoverLocalAdoption(
      projectId,
      documentId,
      generation,
      lineageHandle,
      admitted.exactDatabaseName,
    );

    expect(await persistedAuthority(store)).toEqual({
      phase: "bindable",
      originLineageHandle: lineageHandle,
    });
    expect(installed).toEqual([
      expect.objectContaining({ exactDatabaseName: admitted.exactDatabaseName }),
    ]);
  } finally {
    await coordination.close();
    await store.close();
  }
});

it("backfills the lineage onto a reusable handle-less bindable authority exactly once", async () => {
  const accountId = nextAccount();
  const store = new DocumentSessionAuthorityStore(accountId);
  try {
    await store.admit({ documentId, projectId, generation });
    expect(await persistedAuthority(store)).toEqual({
      phase: "bindable",
      originLineageHandle: undefined,
    });

    await store.admit({ documentId, projectId, generation, originLineageHandle: lineageHandle });
    expect(await persistedAuthority(store)).toEqual({
      phase: "bindable",
      originLineageHandle: lineageHandle,
    });

    await store.admit({
      documentId,
      projectId,
      generation,
      originLineageHandle: "catalog:someone-else",
    });
    expect(await persistedAuthority(store)).toEqual({
      phase: "bindable",
      originLineageHandle: lineageHandle,
    });
  } finally {
    await store.close();
  }
});
