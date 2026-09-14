/** Same-session adoption orchestration around durable resource and authority boundaries. */
import "fake-indexeddb/auto";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import type {
  ResourceKey,
  ResourceNamespaceLock,
  ResourceRecord,
} from "@meridian/resource-replica";
import {
  prepareNamespaceAttempt,
  recordNamespaceOutcome,
  reserveResourceDocument,
  settleNamespaceOutcome,
} from "@meridian/resource-replica";
import Dexie from "dexie";
import { afterEach, expect, it, vi } from "vitest";
import type { LocalAdoptionPendingReceipt } from "@/core/editor/document-session-authority-store";
import type { LocalDocumentSessionFactory } from "@/core/editor/document-session-registry";
import type {
  LocalDocumentSessionAdoptionPort,
  LocalDocumentSessionHandoff,
  LocalDocumentSessionReservationPort,
  LocalDocumentSessionTransfer,
} from "@/core/editor/local-document-session-adoption";
import { DocumentSession, deleteIndexedDb } from "../editor/document-session";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import { ResourceContentAccess } from "./resource-content-access";
import type { ResourceAvailabilityResolver } from "./resource-session-adoption";
import { ResourceSessionAdoptionCoordinator } from "./resource-session-adoption";

const accountId = "resource-session-adoption";
const metadataName = `meridian:resource-metadata:v2:${encodeURIComponent(accountId)}`;
const databaseName = "resource-session-adoption-content";
const stores: IndexedDbResourceMetadata[] = [];
const accesses: ResourceContentAccess[] = [];

function record(): ResourceRecord {
  const reserved = reserveResourceDocument({
    projectId: "project",
    handle: "handle",
    documentId: "document",
    databaseName,
    schema: collabSchemaKeyTag(),
    intentId: "create",
  }).next;
  if (reserved.resource.content.kind === "exact") delete reserved.resource.content.initialization;
  const submitted = prepareNamespaceAttempt(reserved, {
    attemptId: "transition",
    operationId: "unused",
  });
  if (!submitted) throw new Error("Expected create attempt");
  const received = recordNamespaceOutcome(submitted.next, "create", "transition", {
    kind: "create",
    result: {
      status: "created",
      documentId: "document",
      scheme: "manuscript",
      path: "/Untitled.md",
      name: "Untitled.md",
    },
  });
  const adopted = received && settleNamespaceOutcome(received.next);
  if (!adopted) throw new Error("Expected adopted resource");
  adopted.next.resource.revision = 1;
  return adopted.next;
}

function factory(created: DocumentSession[]): LocalDocumentSessionFactory {
  return {
    whenAuthorityReady: async () => undefined,
    createDetached(input) {
      const session = new DocumentSession({
        roomKey: input.documentId,
        persistence: { kind: "indexeddb", key: input.persistenceKey, fresh: input.fresh },
      });
      created.push(session);
      return session;
    },
  };
}

async function fixture() {
  const metadata = new IndexedDbResourceMetadata(accountId, vi.fn());
  stores.push(metadata);
  const initial = record();
  expect(await metadata.commitResource({ expectedRevision: null, next: initial })).toBe(
    "committed",
  );
  const seed = new DocumentSession({
    roomKey: "document",
    persistence: { kind: "indexeddb", key: databaseName, fresh: true },
  });
  await seed.whenLocalPersistenceSynced();
  expect(await seed.hasInitializedLocalContent()).toBe(true);
  seed.document.getText("probe").insert(0, "preserved");
  await seed.destroy();
  const created: DocumentSession[] = [];
  const access = new ResourceContentAccess(
    accountId,
    metadata,
    factory(created),
    new AbortController().signal,
  );
  accesses.push(access);
  const verified = await access.open("project", initial.resource, "fixture");
  if (verified.kind !== "opened") throw new Error(`Fixture content is ${JSON.stringify(verified)}`);
  let transfer: LocalDocumentSessionTransfer | null = null;
  const handoff = Object.freeze({}) as LocalDocumentSessionHandoff;
  const reservations: LocalDocumentSessionReservationPort = {
    reserve: (candidate) => {
      transfer = candidate;
      return handoff;
    },
    abort: vi.fn(),
  };
  const pending: LocalAdoptionPendingReceipt = {
    documentId: "document",
    transitionId: "transition",
    lineageHandle: "handle",
    exactDatabaseName: databaseName,
    targetGeneration: null,
  };
  const release = vi.fn();
  const adoption: LocalDocumentSessionAdoptionPort = {
    begin: vi.fn(async () => pending),
    abort: vi.fn(async () => "aborted" as const),
    inspect: vi.fn(async () => "clear" as const),
    recover: vi.fn(),
    bindAndAdopt: vi.fn(async (input) => {
      const reserved = transfer as LocalDocumentSessionTransfer | null;
      if (!reserved) throw new Error("Missing transfer");
      reserved.prepareCommit();
      await reserved.completeCommit({
        lease: {
          accountId,
          projectId: input.projectId,
          documentId: input.documentId,
          generation: input.generation,
        },
        persistenceGeneration: input.generation,
        exactDatabaseName: databaseName,
        release,
      });
      return {
        lease: {
          accountId,
          projectId: input.projectId,
          documentId: input.documentId,
          generation: input.generation,
        },
        session: reserved.session,
      };
    }),
  };
  const lock: ResourceNamespaceLock = {
    accountId,
    run: async (_key, task) => ({ kind: "acquired", value: await task() }),
  };
  const availability: ResourceAvailabilityResolver & {
    resolve: ReturnType<typeof vi.fn<ResourceAvailabilityResolver["resolve"]>>;
  } = {
    resolve: vi.fn<ResourceAvailabilityResolver["resolve"]>(async () => ({
      kind: "available" as const,
      documentId: "document",
      generation: "7",
    })),
  };
  const coordinator = new ResourceSessionAdoptionCoordinator(
    accountId,
    metadata,
    access,
    reservations,
    adoption,
    lock,
    availability,
  );
  return {
    adoption,
    availability,
    coordinator,
    created,
    key: initial.resource satisfies ResourceKey,
    metadata,
    release,
    verified,
  };
}

afterEach(async () => {
  await Promise.allSettled(accesses.splice(0).map((access) => access.finishClose()));
  await Promise.allSettled(stores.splice(0).map((store) => store.finishClose()));
  await Dexie.delete(metadataName);
  await deleteIndexedDb(databaseName);
  vi.restoreAllMocks();
});

it("pins authority and acknowledges adoption without replacing the local Y.Doc", async () => {
  const { adoption, coordinator, created, key, metadata, release, verified } = await fixture();

  await expect(coordinator.reconcile(key)).resolves.toBe("adopted");

  expect(created).toHaveLength(1);
  expect(created[0]?.document.getText("probe").toString()).toBe("preserved");
  expect(adoption.bindAndAdopt).toHaveBeenCalledOnce();
  expect((await metadata.readResource(key))?.resource).toMatchObject({
    lifecycle: { kind: "acknowledged", availabilityGeneration: "7" },
    obligations: {},
  });
  expect(release).not.toHaveBeenCalled();
  verified.handle.release();
  expect(release).toHaveBeenCalledOnce();
  expect(created[0]?.getSnapshot().status).toBe("detached");
});

it("keeps a begun handoff retryable while authority is temporarily unavailable", async () => {
  const { adoption, availability, coordinator, key, metadata } = await fixture();
  availability.resolve.mockResolvedValueOnce({ kind: "failed" });

  await expect(coordinator.reconcile(key)).resolves.toBe("waiting");
  await expect(coordinator.reconcile(key)).resolves.toBe("adopted");

  expect(adoption.begin).toHaveBeenCalledTimes(2);
  expect(adoption.bindAndAdopt).toHaveBeenCalledOnce();
  expect((await metadata.readResource(key))?.resource.obligations.sessionAdoption).toBeUndefined();
});
