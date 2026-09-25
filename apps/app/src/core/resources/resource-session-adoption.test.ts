/** Same-session adoption orchestration around durable resource and authority boundaries. */
import "fake-indexeddb/auto";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import type {
  ResourceKey,
  ResourceNamespaceLock,
  ResourceRecord,
} from "@meridian/resource-replica";
import {
  markResourceCreateEligible,
  planSessionAdoptionGeneration,
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
import { DocumentSession } from "../editor/document-session";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import { ResourceContentAccess } from "./resource-content-access";
import type { ResourceAvailabilityResolver } from "./resource-session-adoption";
import { ResourceSessionAdoptionCoordinator } from "./resource-session-adoption";
import { deleteIndexedDb } from "./test-support/delete-indexed-db";

const accountId = "resource-session-adoption";
const metadataName = `meridian:resource-metadata:v3:${encodeURIComponent(accountId)}`;
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
  const eligible = markResourceCreateEligible(reserved, 1);
  if (!eligible) throw new Error("Expected create eligibility");
  const submitted = prepareNamespaceAttempt(eligible.next, {
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
  const verified = await access.open("project", initial.resource, "fixture", undefined, {
    adoptionEligible: true,
  });
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
    access,
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

it("waits for a caller-owned lease before transferring and acknowledging the session", async () => {
  const { access, adoption, coordinator, key, metadata, release, verified } = await fixture();
  verified.handle.release();

  await expect(coordinator.reconcile(key)).resolves.toBe("waiting");
  expect(adoption.bindAndAdopt).not.toHaveBeenCalled();
  expect((await metadata.readResource(key))?.resource.obligations.sessionAdoption).toBeDefined();

  const editor = await access.open("project", key, "mounted-editor", undefined, {
    adoptionEligible: true,
  });
  if (editor.kind !== "opened") throw new Error(`Editor content is ${JSON.stringify(editor)}`);
  await expect(coordinator.reconcile(key)).resolves.toBe("adopted");
  expect(adoption.bindAndAdopt).toHaveBeenCalledOnce();
  expect(editor.handle.session.getSnapshot().status).toBe("detached");
  expect(release).not.toHaveBeenCalled();
  editor.handle.release();
  expect(release).toHaveBeenCalledOnce();
});

it("hands recorded bindable authority to the already-open local session", async () => {
  const { adoption, coordinator, created, key, metadata, verified } = await fixture();
  const current = await metadata.readResource(key);
  if (!current) throw new Error("Missing resource record");
  const pinned = planSessionAdoptionGeneration(current, "7");
  if (!pinned) throw new Error("Expected a pending session adoption");
  expect(await metadata.commitResource(pinned)).toBe("committed");
  vi.mocked(adoption.inspect).mockResolvedValue("bindable");

  await expect(coordinator.reconcile(key)).resolves.toBe("adopted");

  expect(adoption.bindAndAdopt).toHaveBeenCalledOnce();
  expect(created).toHaveLength(1);
  expect(created[0]?.document.getText("probe").toString()).toBe("preserved");
  verified.handle.release();
});

it("rejects an authority fence before pinning the resource generation", async () => {
  const { adoption, availability, coordinator, key, metadata, verified } = await fixture();
  availability.resolve.mockResolvedValue({
    kind: "available",
    documentId: "document",
    generation: "8",
  });
  vi.mocked(adoption.inspect).mockImplementation(async (input) =>
    input.generation === "8" ? "mismatch" : "bindable",
  );

  await expect(coordinator.reconcile(key)).rejects.toThrow(
    "Session adoption persistence authority belongs to another lineage",
  );

  expect(adoption.inspect).toHaveBeenCalledWith(expect.objectContaining({ generation: "8" }));
  expect(adoption.begin).not.toHaveBeenCalled();
  expect(
    (await metadata.readResource(key))?.resource.obligations.sessionAdoption?.generation,
  ).toBeNull();
  verified.handle.release();
});

it("keeps a begun handoff retryable while authority is temporarily unavailable", async () => {
  const { adoption, availability, coordinator, key, metadata } = await fixture();
  availability.resolve.mockResolvedValueOnce({ kind: "failed" });

  await expect(coordinator.reconcile(key)).resolves.toBe("waiting");
  await expect(coordinator.reconcile(key)).resolves.toBe("adopted");

  expect(adoption.begin).toHaveBeenCalledTimes(1);
  expect(adoption.bindAndAdopt).toHaveBeenCalledOnce();
  expect((await metadata.readResource(key))?.resource.obligations.sessionAdoption).toBeUndefined();
});
