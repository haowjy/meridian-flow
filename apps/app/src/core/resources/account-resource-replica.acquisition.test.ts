// @vitest-environment jsdom
/**
 * Acquired registry ownership keeps the room's own incarnation, not the fresher admission that
 * reopened it. Real registry, authority store and metadata; only the server sync is scripted.
 */
import "fake-indexeddb/auto";
import { reserveResourceDocument } from "@meridian/resource-replica";
import Dexie from "dexie";
import { expect, it, vi } from "vitest";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { DocumentSessionRegistry } from "@/core/editor/document-session-registry-implementation";
import { AccountResourceReplica } from "./account-resource-replica";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import { deleteIndexedDb } from "./test-support/delete-indexed-db";

vi.mock("@/client/api/projects-api", () => ({
  lookupProjectContextAvailability: async () => ({ resolutions: [] }),
  getContextOperationReceipt: async () => null,
}));

it("keeps the room incarnation when a fresher admission reopens an unacquired cache", async () => {
  vi.stubGlobal("navigator", {
    locks: { request: async (_n: string, _o: unknown, run: (l: unknown) => unknown) => run({}) },
  });
  vi.stubGlobal("isSecureContext", true);
  const accountId = crypto.randomUUID();
  const registry = new DocumentSessionRegistry(undefined, undefined, accountId as never, () => ({
    unacknowledgedUpdates: () => null,
    destroy: () => undefined,
  }));
  const runtime = createAccountDocumentSessionRuntime({
    accountId: accountId as never,
    core: {
      accountId: accountId as never,
      registry,
      localReservation: registry.localTransfers,
      localAdoption: registry.localTransfers,
      localConstruction: registry,
      liveIncarnation: registry,
      connectLocalResources: (port) => registry.connectLocalResources(port),
      beginClose: () => registry.beginCloseAccountRuntime(),
      finishClose: () => registry.closeAccountRuntime(),
    },
  });
  const replica = new AccountResourceReplica(accountId, runtime);
  const writer = new IndexedDbResourceMetadata(accountId, () => {});
  const internals = replica as unknown as {
    metadata: IndexedDbResourceMetadata;
    reconciler: { schedule(key: unknown): void };
    content: { adoptRegistrySession(...args: unknown[]): Promise<void> };
  };
  try {
    // The room was admitted at 7 and survived a reload before any cache metadata was captured.
    const lease = await registry.admit("project", "document", "7");
    const session = registry.get(lease);
    const reserved = reserveResourceDocument({
      projectId: "project",
      handle: "resource",
      documentId: "document",
      databaseName: "unused",
      schema: "schema",
      intentId: "create",
    }).next;
    reserved.resource.content = { kind: "unacquired" };
    reserved.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "6" };
    reserved.resource.obligations = {};
    reserved.intents = [];
    await writer.commitResource({ expectedRevision: null, next: reserved });

    // Visibility needs a catalog checkpoint, and sync needs a server: both are outside this seam.
    vi.spyOn(internals.metadata, "readAccessibleResource").mockImplementation((_p, key) =>
      internals.metadata.readResource(key),
    );
    vi.spyOn(internals.metadata, "resolveAccessibleResource").mockImplementation(() =>
      internals.metadata.readResource({ handle: "resource" }),
    );
    vi.spyOn(internals.reconciler, "schedule").mockImplementation(() => undefined);
    vi.spyOn(session, "whenSynced").mockResolvedValue(undefined);
    vi.spyOn(session, "hasInitializedLocalContent").mockResolvedValue(true);
    vi.spyOn(session, "getSnapshot").mockReturnValue({
      ...session.getSnapshot(),
      status: "synced",
      schemaFence: null,
    });
    const adopt = vi.spyOn(internals.content, "adoptRegistrySession");

    await replica.captureServerSession("project", "document", "9", session);

    expect(registry.incarnationOf(session)).toBe("7");
    expect(adopt.mock.calls[0]?.[3]).toMatchObject({ persistenceGeneration: "7" });
    expect((await writer.readResource({ handle: "resource" }))?.resource.lifecycle).toEqual({
      kind: "acknowledged",
      availabilityGeneration: "7",
    });
  } finally {
    await replica.finishClose();
    await runtime.finishClose();
    await writer.finishClose();
    await Dexie.delete(`meridian:resource-metadata:v4:${encodeURIComponent(accountId)}`);
    await deleteIndexedDb(`meridian:document-session-authority:${encodeURIComponent(accountId)}`);
    vi.unstubAllGlobals();
  }
});
