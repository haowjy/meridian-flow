import "fake-indexeddb/auto";
/** Typed final refusals and persisted receipts prove outcomes; network failures do not. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import {
  type NamespaceRequest,
  type ResourceNamespaceTransport,
  type ResourceRecord,
  reconcileResourceNamespace,
} from "@meridian/resource-replica";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpResponseError, MeridianApiError } from "@/client/api/http-client";
import { type CrossContextLockManager, deferred } from "@/core/cross-context-locks";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import { createResourceNamespaceLock } from "./resource-namespace-lock";
import { createResourceNamespaceTransport } from "./resource-namespace-transport";

const api = vi.hoisted(() => ({
  deleteContextEntry: vi.fn(),
  getContextOperationReceipt: vi.fn(),
  moveContextEntry: vi.fn(),
  createUntitledContextDocument: vi.fn(),
}));
vi.mock("@/client/api/projects-api", () => api);
const request: NamespaceRequest = {
  kind: "delete",
  scheme: "scratch",
  workId: "work",
  workSlug: "alpha",
  body: {
    operationId: "operation",
    path: "note.md",
    expected: { kind: "file", documentId: "document" },
  },
};
const receipt: ContextOperationReceipt = {
  observationVersion: "1",
  operationId: "operation",
  command: {
    kind: "delete",
    uri: "scratch://@alpha/note.md",
    expected: { kind: "file", documentId: "document" },
  },
  result: { ok: false, error: { code: "conflict", uri: "scratch://@alpha/note.md" } },
};
beforeEach(() => vi.resetAllMocks());

it("reads persisted evidence immediately after an HTTP rejection", async () => {
  api.deleteContextEntry.mockRejectedValue(new HttpResponseError("conflict", 409, null));
  api.getContextOperationReceipt.mockResolvedValue(receipt);
  const transport = createResourceNamespaceTransport("account", new AbortController().signal);
  expect(await transport.submit("project", request)).toEqual({ kind: "operation", receipt });
});

it("keeps network failure and missing evidence uncertain", async () => {
  const transport = createResourceNamespaceTransport("account", new AbortController().signal);
  const offline = new TypeError("Failed to fetch");
  api.deleteContextEntry.mockRejectedValue(offline);
  await expect(transport.submit("project", request)).rejects.toBe(offline);
  expect(api.getContextOperationReceipt).not.toHaveBeenCalled();
  const http = new HttpResponseError("unavailable", 503, null);
  api.deleteContextEntry.mockRejectedValue(http);
  api.getContextOperationReceipt.mockResolvedValue(null);
  await expect(transport.submit("project", request)).rejects.toBe(http);
});

it("records a typed final refusal without requiring a server receipt", async () => {
  const error = {
    code: "work_missing",
    message: "Work not found.",
    source: "system" as const,
    retryable: false,
  };
  api.deleteContextEntry.mockRejectedValue(new MeridianApiError(error, 404));
  const transport = createResourceNamespaceTransport("account", new AbortController().signal);
  expect(await transport.submit("project", request)).toEqual({
    kind: "refusal",
    operationId: request.body.operationId,
    error,
  });
  expect(api.getContextOperationReceipt).not.toHaveBeenCalled();
});

class FaithfulLocks implements CrossContextLockManager {
  private readonly held = new Set<string>();

  async request<T>(
    name: string,
    _options: { mode?: "shared" | "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T> {
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

it("allows only one concurrent resource dispatch", async () => {
  const epoch = new AbortController();
  const lock = createResourceNamespaceLock({
    accountId: "account",
    epoch: epoch.signal,
    locks: new FaithfulLocks(),
  });
  const release = deferred<void>();
  const first = lock.run({ handle: "resource" }, async () => {
    await release.promise;
    return "done";
  });
  await expect(lock.run({ handle: "resource" }, async () => "duplicate")).resolves.toEqual({
    kind: "busy",
  });
  release.resolve();
  await expect(first).resolves.toEqual({ kind: "acquired", value: "done" });
});

it("blocks unavailable native locks and account-close admission", async () => {
  const epoch = new AbortController();
  const unavailable = createResourceNamespaceLock({
    accountId: "account",
    epoch: epoch.signal,
    locks: null,
  });
  const task = vi.fn(async () => "unsafe");
  await expect(unavailable.run({ handle: "resource" }, task)).resolves.toEqual({ kind: "busy" });
  expect(task).not.toHaveBeenCalled();
  epoch.abort();
  await expect(unavailable.run({ handle: "resource" }, task)).rejects.toThrow("closing");
});

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
    await Dexie.delete(`meridian:resource-metadata:v4:${encodeURIComponent(account)}`);
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
    lookupIdentity: async () => {
      throw new Error("Unexpected availability lookup");
    },
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
        lookupIdentity: async () => {
          throw new Error("Unexpected availability lookup");
        },
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
