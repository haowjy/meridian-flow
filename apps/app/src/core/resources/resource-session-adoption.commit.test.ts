/**
 * Named-risk witnesses for the adoption commit, at the real seam: the coordinator, resource
 * content access, the registry's transfer facet, `Coordination` with Web Locks semantics, and the
 * authority store over fake IndexedDB. Only the availability answer is scripted.
 */
import "fake-indexeddb/auto";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import type {
  ResourceKey,
  ResourceNamespaceLock,
  ResourceRecord,
} from "@meridian/resource-replica";
import {
  markResourceCreateEligible,
  prepareNamespaceAttempt,
  recordNamespaceOutcome,
  reserveResourceDocument,
  settleNamespaceOutcome,
} from "@meridian/resource-replica";
import Dexie from "dexie";
import { afterEach, expect, it, vi } from "vitest";
import type { CrossContextLockManager } from "../cross-context-locks";
import { DocumentSession } from "../editor/document-session";
import { DocumentSessionAuthorityStore } from "../editor/document-session-authority-store";
import { createDocumentSessionCrossContextCoordination } from "../editor/document-session-cross-context-coordination";
import { DocumentSessionRegistry } from "../editor/document-session-registry-implementation";
import type { LocalDocumentSessionTransfer } from "../editor/local-document-session-adoption";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import { ResourceContentAccess } from "./resource-content-access";
import { ResourceSessionAdoptionCoordinator } from "./resource-session-adoption";
import { deleteIndexedDb } from "./test-support/delete-indexed-db";

const projectId = "project";
const documentId = "document";
const pending = {
  documentId,
  transitionId: "transition",
  lineageHandle: "handle",
  exactDatabaseName: "adoption-commit-content",
};

/** Web Locks semantics for shared/exclusive holders: the operation lock is not reentrant. */
function conflictingLocks(): CrossContextLockManager {
  const held = new Map<string, { shared: number; exclusive: boolean }>();
  const released: Array<() => void> = [];
  return {
    request: async (name, options, callback) => {
      const mode = options.mode ?? "exclusive";
      const state = () => held.get(name) ?? { shared: 0, exclusive: false };
      const free = () => !state().exclusive && (mode === "shared" || state().shared === 0);
      while (!free()) {
        if (options.ifAvailable) return callback(null);
        await new Promise<void>((resolve) => released.push(resolve));
      }
      const next = state();
      if (mode === "shared") next.shared += 1;
      else next.exclusive = true;
      held.set(name, next);
      try {
        return await callback({});
      } finally {
        if (mode === "shared") next.shared -= 1;
        else next.exclusive = false;
        for (const wake of released.splice(0)) wake();
      }
    },
  };
}

function adoptingRecord(legacyPin: boolean): ResourceRecord {
  const reserved = reserveResourceDocument({
    projectId,
    handle: pending.lineageHandle,
    documentId,
    databaseName: pending.exactDatabaseName,
    schema: collabSchemaKeyTag(),
    intentId: "create",
  }).next;
  if (reserved.resource.content.kind === "exact") delete reserved.resource.content.initialization;
  const eligible = markResourceCreateEligible(reserved, 1);
  const submitted =
    eligible &&
    prepareNamespaceAttempt(eligible.next, {
      attemptId: pending.transitionId,
      operationId: "unused",
    });
  const received =
    submitted &&
    recordNamespaceOutcome(submitted.next, "create", pending.transitionId, {
      kind: "create",
      result: {
        status: "created",
        documentId,
        scheme: "manuscript",
        path: "/Untitled.md",
        name: "Untitled.md",
      },
    });
  const adopted = received && settleNamespaceOutcome(received.next);
  if (!adopted) throw new Error("Expected adopted resource");
  adopted.next.resource.revision = 1;
  const obligation = adopted.next.resource.obligations.sessionAdoption;
  // A record the removed pin wrote: an extra field the new protocol must simply ignore.
  if (legacyPin && obligation) Object.assign(obligation, { generation: "7" });
  return adopted.next;
}

let sequence = 0;
const cleanups: Array<() => Promise<void>> = [];

async function seam(seed: "owed" | "reserved" | "legacy-reserved" | "committed" = "owed") {
  const accountId = `adoption-commit-${++sequence}`;
  const metadata = new IndexedDbResourceMetadata(accountId, vi.fn());
  const initial = adoptingRecord(seed === "legacy-reserved");
  expect(await metadata.commitResource({ expectedRevision: null, next: initial })).toBe(
    "committed",
  );
  const seedSession = new DocumentSession({
    roomKey: documentId,
    persistence: { kind: "indexeddb", key: pending.exactDatabaseName, fresh: true },
  });
  await seedSession.whenLocalPersistenceSynced();
  expect(await seedSession.hasInitializedLocalContent()).toBe(true);
  seedSession.document.getText("probe").insert(0, "preserved");
  await seedSession.destroy();

  const registry = new DocumentSessionRegistry(
    (id, local) =>
      createDocumentSessionCrossContextCoordination({
        accountId: id,
        local,
        locks: conflictingLocks(),
        secureContext: true,
        createWakeChannel: null,
        reconcileIntervalMs: 60_000,
      }),
    undefined,
    accountId as never,
  );
  const created: DocumentSession[] = [];
  const access = new ResourceContentAccess(
    accountId,
    metadata,
    {
      whenAuthorityReady: async () => undefined,
      createDetached(input) {
        const session = new DocumentSession({
          roomKey: input.documentId,
          persistence: { kind: "indexeddb", key: input.persistenceKey, fresh: input.fresh },
        });
        created.push(session);
        return session;
      },
    },
    new AbortController().signal,
  );
  const mounted = await access.open(projectId, initial.resource, "mounted-editor", undefined, {
    adoptionEligible: true,
  });
  if (mounted.kind !== "opened") throw new Error(`Content is ${JSON.stringify(mounted)}`);

  const store = new DocumentSessionAuthorityStore(accountId as never);
  if (seed !== "owed") await store.beginLocalAdoption(pending);
  if (seed === "legacy-reserved") await patchRoom(accountId, { targetGeneration: "7" });
  if (seed === "committed") {
    await store.admit({
      documentId,
      projectId,
      generation: "7",
      adoption: { ...pending, beforeWrite: () => undefined },
    });
  }

  const answer = { generation: "9" };
  const lock: ResourceNamespaceLock = {
    accountId,
    run: async (_key, task) => ({ kind: "acquired", value: await task() }),
  };
  const coordinator = new ResourceSessionAdoptionCoordinator(
    accountId,
    metadata,
    access,
    registry.localTransfers,
    registry.localTransfers,
    lock,
    {
      resolve: async () => ({ kind: "available", documentId, generation: answer.generation }),
    },
  );
  cleanups.push(async () => {
    mounted.handle.release();
    await Promise.allSettled([access.finishClose(), metadata.finishClose(), store.close()]);
    await registry.closeAccountRuntime().catch(() => undefined);
    await Promise.allSettled(created.map((session) => session.destroy()));
    await Dexie.delete(`meridian:resource-metadata:v4:${encodeURIComponent(accountId)}`);
    await deleteIndexedDb(`meridian:document-session-authority:${encodeURIComponent(accountId)}`);
    await deleteIndexedDb(pending.exactDatabaseName);
  });
  return {
    access,
    answer,
    coordinator,
    created,
    key: initial.resource satisfies ResourceKey,
    metadata,
    registry,
    room: async () => (await store.readRoom(documentId)).persistence,
    store,
  };
}

async function patchRoom(accountId: string, patch: Record<string, unknown>): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(
      `meridian:document-session-authority:${encodeURIComponent(accountId)}`,
    );
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction("room-order", "readwrite");
  const rooms = transaction.objectStore("room-order");
  const room = await new Promise<{ persistence: object }>((resolve) => {
    const request = rooms.get(documentId);
    request.onsuccess = () => resolve(request.result);
  });
  rooms.put({ ...room, persistence: { ...room.persistence, ...patch } });
  await new Promise<void>((resolve) => {
    transaction.oncomplete = () => resolve();
  });
  database.close();
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

it.each([
  { seed: "reserved", incarnation: "9" },
  { seed: "legacy-reserved", incarnation: "9" },
  { seed: "committed", incarnation: "7" },
] as const)("completes an adoption interrupted at $seed", async ({ seed, incarnation }) => {
  const { coordinator, created, key, metadata, room } = await seam(seed);

  await expect(coordinator.reconcile(key)).resolves.toBe("adopted");

  // The same Y.Doc carries the seeded content across the commit; it is not rebuilt or destroyed.
  expect(created).toHaveLength(1);
  expect(created[0]?.document.getText("probe").toString()).toBe("preserved");
  expect(created[0]?.getSnapshot().status).not.toBe("destroyed");

  expect(await room()).toMatchObject({
    phase: "bindable",
    generation: incarnation,
    exactDatabaseName: pending.exactDatabaseName,
    originLineageHandle: pending.lineageHandle,
  });
  const resource = (await metadata.readResource(key))?.resource;
  expect(resource?.lifecycle).toEqual({
    kind: "acknowledged",
    availabilityGeneration: incarnation,
  });
  expect(resource?.obligations.sessionAdoption).toBeUndefined();
});

it("releases a fence-refused reservation and adopts at the next fresh admission", async () => {
  const { access, answer, coordinator, created, key, metadata, registry, room } = await seam();
  await registry.revokeAccess(projectId, documentId, "120", "revoke:120");
  answer.generation = "119";

  await expect(coordinator.reconcile(key)).rejects.toThrow(/revoked/);
  // Both reservation owners settled: this transfer reserves again, rather than inheriting one.
  const request = {
    projectId,
    key,
    transitionId: pending.transitionId,
    documentId,
    identityRevision: 1,
    databaseName: pending.exactDatabaseName,
  };
  const again = await access.reserveTransfer(request, registry.localTransfers);
  expect(again.kind).toBe("reserved");
  access.abortTransfer(key);

  answer.generation = "125";
  await expect(coordinator.reconcile(key)).resolves.toBe("adopted");
  expect(await room()).toMatchObject({ phase: "bindable", generation: "125" });
  expect((await metadata.readResource(key))?.resource.obligations.sessionAdoption).toBeUndefined();
  expect(created).toHaveLength(1);
  expect(created[0]?.document.getText("probe").toString()).toBe("preserved");
});

it("re-acknowledges the committed incarnation after a failed acknowledgement", async () => {
  const { answer, coordinator, created, key, metadata, room, store } = await seam("committed");
  answer.generation = "9";
  const commit = metadata.commitResource.bind(metadata);
  let failed = false;
  vi.spyOn(metadata, "commitResource").mockImplementation(async (write) => {
    if (!failed && !write.next.resource.obligations.sessionAdoption) {
      failed = true;
      throw new Error("transient acknowledgement failure");
    }
    return commit(write);
  });

  await expect(coordinator.reconcile(key)).rejects.toThrow("transient acknowledgement failure");
  // The registry now owns a live transport: a failed acknowledgement must not label it offline.
  created[0]?.attachTransport(() => ({
    unacknowledgedUpdates: () => null,
    synced: true,
    whenSynced: Promise.resolve(),
    whenDurablySynced: Promise.resolve(),
    subscribeStatus(listener) {
      listener({ kind: "connected" });
      return () => {};
    },
    destroy() {},
  }));
  await vi.waitFor(() =>
    expect(created[0]?.getSnapshot()).toMatchObject({ status: "synced", adoptionStalled: false }),
  );
  await expect(coordinator.reconcile(key)).resolves.toBe("adopted");

  expect(created[0]?.getSnapshot()).toMatchObject({ status: "synced", adoptionStalled: false });
  expect(await room()).toMatchObject({ phase: "bindable", generation: "7" });
  const resource = (await metadata.readResource(key))?.resource;
  expect(resource?.lifecycle).toEqual({ kind: "acknowledged", availabilityGeneration: "7" });
  expect(resource?.obligations.sessionAdoption).toBeUndefined();
  expect(created[0]?.document.getText("probe").toString()).toBe("preserved");
  expect((await store.readRoom(documentId)).documentAdmittedThrough).toBe("9");
});

it("settles a revocation that queues behind the commit without deadlock", async () => {
  const { coordinator, key, registry, access } = await seam();
  const original = registry.localTransfers.reserve.bind(registry.localTransfers);
  let revoked: Promise<unknown> | undefined;
  // Queue the revoke from inside prepareCommit: the commit holds the operation lock at that point.
  vi.spyOn(registry.localTransfers, "reserve").mockImplementation((transfer) =>
    original({
      ...transfer,
      prepareCommit: () => {
        transfer.prepareCommit();
        revoked = registry.revokeAccess(projectId, documentId, "200", "revoke:200");
      },
    }),
  );

  await expect(
    Promise.race([
      coordinator.reconcile(key),
      new Promise((_, reject) => setTimeout(() => reject(new Error("deadlock")), 3_000)),
    ]),
  ).resolves.toBe("adopted");
  await expect(revoked).resolves.toMatchObject({ revokedThrough: "200" });

  // The drain ran after the commit, so nothing at or below its fence is admitted afterwards.
  await expect(registry.admit(projectId, documentId, "150")).rejects.toThrow(/revoked/);
  void access;
});

it("keeps the commit hooks synchronous: an async hook does not typecheck", () => {
  // The coordinator ignores a hook's return value, so a promise would run after the lock is gone.
  // @ts-expect-error `undefined` rejects the promise an `async` hook returns
  const prepare: LocalDocumentSessionTransfer["prepareCommit"] = async () => undefined;
  expect(prepare).toBeTypeOf("function");
});
