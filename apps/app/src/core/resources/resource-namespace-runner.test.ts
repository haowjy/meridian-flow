/** IndexedDB integration for crash-safe namespace request and outcome ordering. */
import "fake-indexeddb/auto";
import {
  type ResourceNamespaceTransport,
  type ResourceRecord,
  reconcileResourceNamespace,
} from "@meridian/resource-replica";
import Dexie from "dexie";
import { afterEach, expect, it, vi } from "vitest";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";

const stores: IndexedDbResourceMetadata[] = [];
const accounts = new Set<string>();

function open(accountId: string) {
  accounts.add(accountId);
  const store = new IndexedDbResourceMetadata(accountId, vi.fn());
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.finishClose()));
  for (const account of accounts)
    await Dexie.delete(`meridian:resource-metadata:v3:${encodeURIComponent(account)}`);
  accounts.clear();
});

function local(): ResourceRecord {
  return {
    resource: {
      handle: "resource",
      revision: 1,
      identity: { documentId: "document", revision: 1 },
      content: { kind: "exact", databaseName: "content", schema: null },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: { createEligibility: { eligibleAt: 1 } },
    },
    intents: [
      {
        projectId: "project",
        handle: "resource",
        intentId: "create",
        sequence: 1,
        identityRevision: 1,
        desired: { kind: "create", folderPath: "" },
        attempts: [],
        state: "pending",
      },
    ],
  };
}

const immediateLock = (accountId: string) => ({
  accountId,
  async run<T>(_key: unknown, task: () => Promise<T>) {
    return { kind: "acquired" as const, value: await task() };
  },
});

function ids() {
  return { attemptId: "attempt", operationId: "operation" };
}

it("recovers a committed remote create after response loss and browser restart", async () => {
  const accountId = crypto.randomUUID();
  const first = open(accountId);
  await first.commitResource({ expectedRevision: null, next: local() });
  const lostResponse: ResourceNamespaceTransport = {
    accountId,
    readOutcome: async () => null,
    async submit() {
      expect((await first.readResource(local().resource))?.intents[0]?.state).toBe("submitted");
      throw new Error("response lost after commit");
    },
  };
  await expect(
    reconcileResourceNamespace({
      key: local().resource,
      metadata: first,
      lock: immediateLock(accountId),
      transport: lostResponse,
      newAttemptIds: ids,
    }),
  ).rejects.toThrow("response lost after commit");
  expect((await first.readResource(local().resource))?.intents[0]?.state).toBe("submitted");
  await first.finishClose();

  const restored = open(accountId);
  const submit = vi.fn(async (_projectId, request) => {
    expect(request).toEqual(
      (await restored.readResource(local().resource))?.intents[0]?.attempts[0]?.request,
    );
    return {
      kind: "create" as const,
      result: {
        status: "already-materialized" as const,
        documentId: "document",
        scheme: "unfiled" as const,
        path: "/Untitled.md",
        name: "Untitled.md",
      },
    };
  });
  await expect(
    reconcileResourceNamespace({
      key: local().resource,
      metadata: restored,
      lock: immediateLock(accountId),
      transport: {
        accountId,
        readOutcome: async () => null,
        submit,
      },
      newAttemptIds: ids,
    }),
  ).resolves.toBe("progressed");
  expect(submit).toHaveBeenCalledOnce();
  expect(await restored.readResource(local().resource)).toMatchObject({
    resource: {
      canonical: {
        scheme: "unfiled",
        path: "/Untitled.md",
        name: "Untitled.md",
        workId: null,
      },
      lifecycle: { kind: "acknowledged", availabilityGeneration: null },
    },
    intents: [{ state: "settled" }],
  });
});
