/** Durable namespace policy protects request bytes, response-loss recovery and newer intentions.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Durable-before-send namespace attempts and CAS replay
 */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { planResourceDeletion } from "./resource-deletion";
import {
  installCanonicalRefresh,
  namespaceOutcomeMatches,
  prepareNamespaceAttempt,
  reconcileResourceNamespace,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "./resource-namespace";
import { projectResourceLocation, projectResourceNeedsRepair } from "./resource-projection";
import type {
  NamespaceAttempt,
  NamespaceOutcome,
  ResourceMetadataStore,
  ResourceNamespaceTransport,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";
import { validateResourceRecordUpdate } from "./resource-records-policy";
import { planResourceLocation } from "./resource-state";

function local(): ResourceRecord {
  return {
    resource: {
      handle: "resource",
      revision: 1,
      identity: { documentId: "document", revision: 1 },
      content: { kind: "exact", databaseName: "content", schema: null },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      materialization: {
        kind: "untitled",
        folderPath: "drafts",
        provisionalName: "Untitled",
      },
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
        desired: { kind: "set-location", typedName: "Untitled" },
        attempts: [],
        state: "pending",
      },
    ],
  };
}

function createOutcome(name = "Untitled"): Extract<NamespaceOutcome, { kind: "create" }> {
  return {
    kind: "create",
    result: {
      status: "created",
      documentId: "document",
      scheme: "unfiled",
      path: `/drafts/${name}`,
      name,
    },
  };
}

class MemoryStore {
  readonly accountId = "account";
  record: ResourceRecord;
  staleAtRevision: number | null = null;

  constructor(record = local()) {
    this.record = structuredClone(record);
  }

  async readResource() {
    return structuredClone(this.record);
  }

  async readAccessibleResource() {
    return this.readResource();
  }

  async commitResource(write: ResourceWrite) {
    if (this.staleAtRevision === write.expectedRevision) {
      this.staleAtRevision = null;
      return "stale" as const;
    }
    if (write.expectedRevision !== this.record.resource.revision) return "stale" as const;
    validateResourceRecordUpdate(this.record, write.next);
    this.record = structuredClone(write.next);
    return "committed" as const;
  }
}

function asMetadata(store: MemoryStore): ResourceMetadataStore {
  return store as unknown as ResourceMetadataStore;
}

const immediateLock = {
  accountId: "account",
  async run<T>(_key: unknown, task: () => Promise<T>) {
    return { kind: "acquired" as const, value: await task() };
  },
};

function transport(input: {
  read?: () => Promise<NamespaceOutcome | null>;
  submit?: () => Promise<NamespaceOutcome | null>;
}): ResourceNamespaceTransport {
  return {
    accountId: "account",
    lookupIdentity: async () => {
      throw new Error("Unexpected availability lookup");
    },
    readOutcome: input.read ?? (async () => null),
    submit: input.submit ?? (async () => createOutcome()),
  };
}

describe("namespace record transitions", () => {
  it.each([
    { createEligibility: { eligibleAt: null } },
  ])("keeps an ineligible local reservation off the network", (obligations) => {
    const record = local();
    record.resource.obligations = obligations;

    expect(
      prepareNamespaceAttempt(
        record,
        {
          attemptId: "attempt",
          operationId: "unused-create-operation",
        },
        (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
      ),
    ).toBeNull();
  });

  it("does not dispatch creation before exact local content is initialized", () => {
    const record = local();
    if (record.resource.content.kind !== "exact") throw new Error("Expected exact content");
    record.resource.content.initialization = "reserved";

    expect(
      prepareNamespaceAttempt(
        record,
        {
          attemptId: "attempt",
          operationId: "unused-create-operation",
        },
        (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
      ),
    ).toBeNull();
  });

  it("persists immutable create request bytes before an outcome can be recorded", () => {
    const before = local();
    const submitted = prepareNamespaceAttempt(
      before,
      {
        attemptId: "attempt",
        operationId: "unused-create-operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    expect(submitted?.next.intents[0]?.attempts[0]).toEqual({
      attemptId: "attempt",
      request: {
        kind: "create",
        body: { documentId: "document", folderPath: "drafts" },
      },
    });
    if (!submitted) throw new Error("missing submitted write");
    expect(() => validateResourceRecordUpdate(before, submitted.next)).not.toThrow();
    const received = recordNamespaceOutcome(submitted.next, "create", "attempt", createOutcome());
    if (!received) throw new Error("missing received write");
    expect(received.next.intents[0]?.state).toBe("received");
    expect(() => validateResourceRecordUpdate(submitted.next, received.next)).not.toThrow();
    const settled = settleNamespaceOutcome(received.next);
    expect(settled?.next.resource).toMatchObject({
      canonical: {
        scheme: "unfiled",
        path: "/drafts/Untitled",
        name: "Untitled",
        workId: null,
      },
      lifecycle: { kind: "acknowledged", availabilityGeneration: null },
      obligations: {
        sessionAdoption: {
          transitionId: "attempt",
          projectId: "project",
          documentId: "document",
          identityRevision: 1,
          exactDatabaseName: "content",
        },
      },
    });
    expect(settled?.next.intents[0]?.state).toBe("settled");
    if (settled)
      expect(() => validateResourceRecordUpdate(received.next, settled.next)).not.toThrow();
  });

  it("turns an exact delete receipt into terminal authority without purging local content", () => {
    const before = local();
    before.resource.canonical = {
      scheme: "unfiled",
      path: "/drafts/Document",
      name: "Document",
      workId: null,
    };
    before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "old" };
    before.intents = [
      {
        ...before.intents[0],
        intentId: "delete",
        desired: { kind: "delete" },
      },
    ];
    const submitted = prepareNamespaceAttempt(
      before,
      {
        attemptId: "attempt",
        operationId: "operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    if (!submitted) throw new Error("missing submitted write");
    const receipt: ContextOperationReceipt = {
      observationVersion: "1",
      operationId: "operation",
      command: {
        kind: "delete",
        uri: "unfiled://drafts/Document",
        expected: { kind: "file", documentId: "document" },
      },
      result: {
        ok: true,
        value: {
          status: "deleted",
          removed: [
            {
              documentId: "document",
              removal: { time: "2026-01-01T00:00:00.000Z", locationVersion: "1" },
            },
          ],
          availabilityGeneration: "2",
        },
      },
    };
    const received = recordNamespaceOutcome(submitted.next, "delete", "attempt", {
      kind: "operation",
      receipt,
    });
    if (!received) throw new Error("missing received write");
    const settled = settleNamespaceOutcome(received.next);
    expect(settled?.next.resource.lifecycle).toEqual({
      kind: "terminal",
      generation: "2",
      transitionId: "operation",
      deletionVersion: "1",
    });
    expect(settled?.next.resource.content).toEqual(before.resource.content);
    expect(settled?.next.resource.canonical).toBeNull();
  });

  it("retains a newer observed canonical location when settling a historical move", () => {
    const before = local();
    before.resource.canonical = {
      scheme: "unfiled",
      path: "/before",
      name: "before",
      workId: null,
    };
    before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    before.intents = [
      {
        ...before.intents[0],
        intentId: "move",
        desired: {
          kind: "set-location",
          typedName: "after",
          destination: { parent: { kind: "folder", folderId: "chapters" }, name: "after" },
        },
      },
    ];
    const submitted = prepareNamespaceAttempt(
      before,
      {
        attemptId: "attempt",
        operationId: "operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    if (!submitted) throw new Error("missing submitted write");
    const received = recordNamespaceOutcome(submitted.next, "move", "attempt", {
      kind: "operation",
      receipt: {
        observationVersion: "1",
        operationId: "operation",
        command: {
          destinationParent: { kind: "folder" as const, folderId: "chapters" },
          kind: "move",
          sourceUri: "unfiled://before",
          destinationUri: "manuscript://chapters/after",
          expected: { kind: "file", nodeId: "document" },
        },
        result: {
          ok: true,
          value: { movedNodeId: "document", destinationPath: "chapters/after" },
        },
      },
    });
    if (!received) throw new Error("missing received write");
    expect(settleNamespaceOutcome(received.next)?.next.resource.canonical).toEqual(
      before.resource.canonical,
    );
    received.next.resource.canonical = {
      scheme: "manuscript",
      path: "/externally-renamed",
      name: "externally-renamed",
      workId: null,
    };
    const settled = settleNamespaceOutcome(received.next);
    expect(settled?.next.resource.canonical).toEqual(received.next.resource.canonical);
    expect(settled?.next.intents[0]?.state).toBe("settled");
    expect(settled?.next.resource.obligations.canonicalRefresh).toEqual({
      observationVersion: "1",
      operationId: "operation",
      identityRevision: 1,
    });
  });

  it("blocks a queued delete until a post-move catalog observation supplies its source", () => {
    const before = local();
    before.resource.canonical = {
      scheme: "unfiled",
      path: "/before",
      name: "before",
      workId: null,
    };
    before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    before.intents = [
      {
        ...before.intents[0],
        intentId: "move",
        desired: {
          kind: "set-location",
          typedName: "after",
          destination: { parent: { kind: "folder", folderId: "chapters" }, name: "after" },
        },
      },
      {
        ...before.intents[0],
        intentId: "delete",
        sequence: 2,
        desired: { kind: "delete" },
      },
    ];
    const submitted = prepareNamespaceAttempt(
      before,
      {
        attemptId: "move-attempt",
        operationId: "move-operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    if (!submitted) throw new Error("missing move attempt");
    const received = recordNamespaceOutcome(submitted.next, "move", "move-attempt", {
      kind: "operation",
      receipt: {
        observationVersion: "1",
        operationId: "move-operation",
        command: {
          destinationParent: { kind: "folder" as const, folderId: "chapters" },
          kind: "move",
          sourceUri: "unfiled://before",
          destinationUri: "manuscript://chapters/after",
          expected: { kind: "file", nodeId: "document" },
        },
        result: {
          ok: true,
          value: { movedNodeId: "document", destinationPath: "chapters/after" },
        },
      },
    });
    if (!received) throw new Error("missing move outcome");
    const settled = settleNamespaceOutcome(received.next);
    if (!settled) throw new Error("missing move settlement");
    expect(
      prepareNamespaceAttempt(
        settled.next,
        {
          attemptId: "delete-attempt",
          operationId: "delete-operation",
        },
        (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
      ),
    ).toBeNull();
    const refreshed = installCanonicalRefresh({
      observationVersion: "1",
      record: settled.next,
      operationId: "move-operation",
      parent: { kind: "folder", folderId: "chapters" },
      location: {
        scheme: "manuscript",
        path: "/chapters/after",
        name: "after",
        workId: null,
      },
    });
    if (!refreshed) throw new Error("missing canonical refresh");
    expect(() => validateResourceRecordUpdate(settled.next, refreshed.next)).not.toThrow();
    const deletion = prepareNamespaceAttempt(
      refreshed.next,
      {
        attemptId: "delete-attempt",
        operationId: "delete-operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    expect(deletion?.next.intents[1]?.attempts[0]?.request).toMatchObject({
      kind: "delete",
      scheme: "manuscript",
      body: { path: "chapters/after" },
    });
  });

  it("rejects a receipt for a different immutable source path", () => {
    const before = local();
    before.resource.canonical = {
      scheme: "unfiled",
      path: "/before",
      name: "before",
      workId: null,
    };
    before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    before.intents = [
      {
        ...before.intents[0],
        intentId: "delete",
        desired: { kind: "delete" },
      },
    ];
    const submitted = prepareNamespaceAttempt(
      before,
      {
        attemptId: "attempt",
        operationId: "operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    if (!submitted) throw new Error("missing submitted write");
    expect(() =>
      recordNamespaceOutcome(submitted.next, "delete", "attempt", {
        kind: "operation",
        receipt: {
          observationVersion: "1",
          operationId: "operation",
          command: {
            kind: "delete",
            uri: "unfiled://replacement",
            expected: { kind: "file", documentId: "document" },
          },
          result: {
            ok: true,
            value: {
              status: "deleted",
              removed: [
                {
                  documentId: "document",
                  removal: { time: "2026-01-01T00:00:00.000Z", locationVersion: "1" },
                },
              ],
              availabilityGeneration: "2",
            },
          },
        },
      }),
    ).toThrow("does not match current attempt");
  });

  it("rejects same-path receipts resolved under another Work authority", () => {
    const before = local();
    before.resource.canonical = {
      scheme: "scratch",
      path: "/note",
      name: "note",
      workId: "work-a",
      workHandle: "w1",
    };
    before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    before.intents = [
      {
        ...before.intents[0],
        intentId: "delete",
        desired: { kind: "delete" },
      },
    ];
    const submitted = prepareNamespaceAttempt(
      before,
      {
        attemptId: "attempt",
        operationId: "operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    if (!submitted) throw new Error("missing submitted write");
    expect(() =>
      recordNamespaceOutcome(submitted.next, "delete", "attempt", {
        kind: "operation",
        receipt: {
          observationVersion: "1",
          operationId: "operation",
          command: {
            kind: "delete",
            uri: "scratch://@w2/note",
            expected: { kind: "file", documentId: "document" },
          },
          result: {
            ok: true,
            value: {
              status: "deleted",
              removed: [
                {
                  documentId: "document",
                  removal: { time: "2026-01-01T00:00:00.000Z", locationVersion: "1" },
                },
              ],
              availabilityGeneration: "2",
            },
          },
        },
      }),
    ).toThrow("does not match current attempt");
  });
});

describe("a chat's Scratch owner", () => {
  function lineageNote(): ResourceRecord {
    const record = local();
    record.resource.canonical = {
      scheme: "scratch",
      path: "/duel/beats",
      name: "beats",
      workId: null,
      rootThreadId: "root-c12",
      rootThreadRef: "c12",
    };
    record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    return record;
  }

  it("names the lineage and its handle on the source side of a move out", () => {
    const record = lineageNote();
    record.intents = [
      {
        ...(record.intents[0] as ResourceRecord["intents"][number]),
        intentId: "move-out",
        desired: {
          kind: "set-location",
          typedName: "beats",
          destination: {
            parent: { kind: "root", scheme: "manuscript", owner: { workId: null } },
            name: "beats",
          },
        },
      },
    ];
    const submitted = prepareNamespaceAttempt(
      record,
      {
        attemptId: "attempt",
        operationId: "operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    const request = submitted?.next.intents[0]?.attempts[0]?.request;
    expect(request).toMatchObject({
      kind: "move",
      sourceRootThreadRef: "c12",
      destinationRootThreadRef: null,
      body: { sourceRootThreadId: "root-c12", destinationRootThreadId: null, sourceWorkId: null },
    });
  });

  it("accepts a delete receipt under its own lineage handle and rejects another chat's", () => {
    const record = lineageNote();
    record.intents = [
      {
        ...(record.intents[0] as ResourceRecord["intents"][number]),
        intentId: "delete",
        desired: { kind: "delete" },
      },
    ];
    const submitted = prepareNamespaceAttempt(
      record,
      {
        attemptId: "attempt",
        operationId: "operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    if (!submitted) throw new Error("missing submitted write");
    const receipt = (uri: string): NamespaceOutcome => ({
      kind: "operation",
      receipt: {
        observationVersion: "1",
        operationId: "operation",
        command: { kind: "delete", uri, expected: { kind: "file", documentId: "document" } },
        result: {
          ok: true,
          value: {
            status: "deleted",
            removed: [
              {
                documentId: "document",
                removal: { time: "2026-01-01T00:00:00.000Z", locationVersion: "1" },
              },
            ],
            availabilityGeneration: "2",
          },
        },
      },
    });
    expect(() =>
      recordNamespaceOutcome(
        submitted.next,
        "delete",
        "attempt",
        receipt("scratch://@c12/duel/beats"),
      ),
    ).not.toThrow();
    expect(() =>
      recordNamespaceOutcome(
        submitted.next,
        "delete",
        "attempt",
        receipt("scratch://@c40/duel/beats"),
      ),
    ).toThrow("does not match current attempt");
  });
});

describe("namespace reconciliation", () => {
  it("makes the submitted request observable before transport dispatch", async () => {
    const store = new MemoryStore();
    const submit = vi.fn(async () => {
      expect(store.record.intents[0]?.state).toBe("submitted");
      expect(store.record.intents[0]?.attempts[0]?.request).toBeDefined();
      return createOutcome();
    });
    await expect(
      reconcileResourceNamespace({
        key: store.record.resource,
        metadata: asMetadata(store),
        lock: immediateLock,
        transport: transport({ submit }),
        newAttemptIds: () => ({ attemptId: "attempt", operationId: "operation" }),
      }),
    ).resolves.toBe("progressed");
    expect(submit).toHaveBeenCalledOnce();
    expect(store.record.intents[0]?.state).toBe("settled");
  });

  it("replays the exact stored create request when no historical receipt exists", async () => {
    const store = new MemoryStore();
    const submitted = prepareNamespaceAttempt(
      store.record,
      {
        attemptId: "attempt",
        operationId: "operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    if (!submitted) throw new Error("missing submitted write");
    store.record = submitted.next;
    const read = vi.fn(async () => null);
    const submit = vi.fn(async () => ({
      kind: "create" as const,
      result: {
        status: "already-materialized" as const,
        documentId: "document",
        scheme: "unfiled" as const,
        path: "/drafts/Untitled",
        name: "Untitled",
      },
    }));
    await expect(
      reconcileResourceNamespace({
        key: store.record.resource,
        metadata: asMetadata(store),
        lock: immediateLock,
        transport: transport({ read, submit }),
        newAttemptIds: () => ({ attemptId: "unused", operationId: "unused" }),
      }),
    ).resolves.toBe("progressed");
    expect(read).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
  });

  it("retries stale metadata commits with one captured outcome and no duplicate dispatch", async () => {
    const store = new MemoryStore();
    const submit = vi.fn(async () => createOutcome());
    // Revision 2 is the submitted attempt; fail its first outcome installation CAS.
    store.staleAtRevision = 2;
    await expect(
      reconcileResourceNamespace({
        key: store.record.resource,
        metadata: asMetadata(store),
        lock: immediateLock,
        transport: transport({ submit }),
        newAttemptIds: () => ({ attemptId: "attempt", operationId: "operation" }),
      }),
    ).resolves.toBe("progressed");
    expect(submit).toHaveBeenCalledOnce();
  });

  it("revalidates identity after receipt lookup before dispatch", async () => {
    const store = new MemoryStore();
    const submitted = prepareNamespaceAttempt(
      store.record,
      {
        attemptId: "attempt",
        operationId: "operation",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    );
    if (!submitted) throw new Error("missing submitted write");
    store.record = submitted.next;
    let finishLookup!: () => void;
    const lookup = new Promise<void>((resolve) => {
      finishLookup = resolve;
    });
    const submit = vi.fn(async () => createOutcome());
    const running = reconcileResourceNamespace({
      key: store.record.resource,
      metadata: asMetadata(store),
      lock: immediateLock,
      transport: transport({
        read: async () => {
          await lookup;
          return null;
        },
        submit,
      }),
      newAttemptIds: () => ({ attemptId: "unused", operationId: "unused" }),
    });
    store.record.resource.identity = { documentId: "replacement", revision: 2 };
    finishLookup();
    await expect(running).resolves.toBe("uncertain");
    expect(submit).not.toHaveBeenCalled();
  });
});

it.each([
  ["work_archived", false],
  ["work_archived", true],
] as const)("keeps accepted placement after %s (receiptless %s) and does not replay", async (reason, receiptless) => {
  const before = local();
  before.resource.canonical = {
    scheme: "scratch",
    path: "/before",
    name: "before",
    workId: "work",
    workHandle: "w5",
  };
  before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  before.intents = [
    {
      ...before.intents[0],
      intentId: "move",
      desired: {
        kind: "set-location",
        typedName: "after",
        destination: {
          parent: { kind: "root", scheme: "scratch", owner: { workId: "work", workHandle: "w5" } },
          name: "after",
        },
      },
    },
  ];
  const store = new MemoryStore(before);
  const result = await reconcileResourceNamespace({
    key: before.resource,
    metadata: asMetadata(store),
    lock: immediateLock,
    newAttemptIds: () => ({ attemptId: "attempt", operationId: "operation" }),
    transport: transport({
      submit: async () =>
        receiptless
          ? {
              kind: "refusal",
              operationId: "operation",
              error: {
                code: reason,
                message: "Work unavailable",
                source: "system",
                retryable: false,
              },
            }
          : {
              kind: "operation",
              receipt: {
                observationVersion: "1",
                operationId: "operation",
                command: {
                  destinationParent: {
                    kind: "root" as const,
                    scheme: "scratch" as const,
                    owner: { workId: "work", workHandle: "w5" },
                  },
                  kind: "move",
                  sourceUri: "scratch://@w5/before",
                  destinationUri: "scratch://@w5/after",
                  expected: { kind: "file", nodeId: "document" },
                },
                result: {
                  ok: false,
                  error: {
                    code: "context_unavailable",
                    reason,
                    workHandle: "w5",
                    uri: "scratch://@w5/after",
                  },
                },
              },
            },
    }),
  });
  expect(result).toBe("needs-repair");
  expect(store.record.resource.identity.documentId).toBe("document");
  expect(projectResourceLocation("project", store.record)?.path).toBe("/before");
  expect(projectResourceNeedsRepair("project", store.record)).toEqual({
    intentId: "move",
    kind: "set-location",
    name: "after",
    destination: {
      parent: { kind: "root", scheme: "scratch", owner: { workId: "work", workHandle: "w5" } },
      name: "after",
    },
  });
  const noReplay = vi.fn();
  await expect(
    reconcileResourceNamespace({
      key: before.resource,
      metadata: asMetadata(store),
      lock: immediateLock,
      newAttemptIds: () => ({ attemptId: "unused", operationId: "unused" }),
      transport: transport({ submit: noReplay }),
    }),
  ).resolves.toBe("needs-repair");
  expect(noReplay).not.toHaveBeenCalled();
  const rejectedRename = structuredClone(store.record.intents[0]?.attempts);
  const deletion = planResourceDeletion(store.record, "project", "delete");
  if (!deletion) throw new Error("Delete must supersede the rejected rename");
  await store.commitResource(deletion);
  expect(store.record.intents[0]?.state).toBe("superseded");
  expect(store.record.intents[0]?.attempts).toEqual(rejectedRename);
  expect(() =>
    validateResourceRecordUpdate(store.record, {
      ...store.record,
      resource: { ...store.record.resource, revision: store.record.resource.revision + 1 },
      intents: store.record.intents.map((intent) =>
        intent.state === "superseded" ? { ...intent, state: "needs-repair" } : intent,
      ),
    }),
  ).toThrow("Terminal intentions cannot restart");
  expect(projectResourceNeedsRepair("project", store.record)).toBeNull();
  expect(projectResourceLocation("project", store.record)).toBeNull();
  expect(
    await reconcileResourceNamespace({
      key: before.resource,
      metadata: asMetadata(store),
      lock: immediateLock,
      newAttemptIds: () => ({ attemptId: "delete-attempt", operationId: "delete-operation" }),
      transport: transport({
        submit: async () => ({
          kind: "operation",
          receipt: {
            observationVersion: "1",
            operationId: "delete-operation",
            command: {
              kind: "delete",
              uri: "scratch://@w5/before",
              expected: { kind: "file", documentId: "document" },
            },
            result: { ok: false, error: { code: "conflict", uri: "scratch://@w5/before" } },
          },
        }),
      }),
    }),
  ).toBe("needs-repair");
  expect(projectResourceLocation("project", store.record)?.path).toBe("/before");
  expect(projectResourceNeedsRepair("project", store.record)?.kind).toBe("delete");
});

it("restores a rejected delete after retry and admits another delete", async () => {
  const before = local();
  before.resource.canonical = {
    scheme: "scratch",
    path: "/note",
    name: "note",
    workId: "work",
    workHandle: "w1",
  };
  before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  before.intents = [];
  const store = new MemoryStore(before);
  for (const number of [1, 2]) {
    const write = planResourceDeletion(store.record, "project", `delete-${number}`);
    if (!write) throw new Error("Delete must be admitted");
    await store.commitResource(write);
    expect(projectResourceLocation("project", store.record)).toBeNull();
    expect(
      await reconcileResourceNamespace({
        key: before.resource,
        metadata: asMetadata(store),
        lock: immediateLock,
        newAttemptIds: () => ({
          attemptId: `attempt-${number}`,
          operationId: `operation-${number}`,
        }),
        transport: transport({
          submit: async () => ({
            kind: "operation",
            receipt: {
              observationVersion: "1",
              operationId: `operation-${number}`,
              command: {
                kind: "delete",
                uri: "scratch://@w1/note",
                expected: { kind: "file", documentId: "document" },
              },
              result: { ok: false, error: { code: "conflict", uri: "scratch://@w1/note" } },
            },
          }),
        }),
      }),
    ).toBe("needs-repair");
    expect(projectResourceLocation("project", store.record)?.path).toBe("/note");
  }
  expect(planResourceDeletion(store.record, "project", "delete-3")).not.toBeNull();
});

it("offers the latest queued file name after refusal and retries from accepted placement", () => {
  const before = local();
  const source = { scheme: "manuscript" as const, path: "/A", name: "A", workId: null };
  before.resource.canonical = source;
  before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  before.intents = [];
  const location = (record: ResourceRecord, name: string) => {
    const write = planResourceLocation({
      record,
      projectId: "project",
      intentId: name,
      operationId: name,
      eligibleAt: 1,
      destination: {
        parent: { kind: "root", scheme: "manuscript", owner: { workId: null } },
        name: name,
      },
    });
    if (!write) throw new Error("Missing location command");
    validateResourceRecordUpdate(record, write.next);
    return write.next;
  };
  const renamed = location(before, "B");
  const submitted = prepareNamespaceAttempt(
    renamed,
    { attemptId: "attempt", operationId: "B" },
    (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
  );
  if (!submitted) throw new Error("Missing submission");
  const queued = location(submitted.next, "C");
  const received = recordNamespaceOutcome(queued, "B", "attempt", {
    kind: "operation",
    receipt: {
      observationVersion: "1",
      operationId: "B",
      command: {
        destinationParent: {
          kind: "root" as const,
          scheme: "manuscript" as const,
          owner: { workId: null },
        },
        kind: "move",
        sourceUri: "manuscript://A",
        destinationUri: "manuscript://B",
        expected: { kind: "file", nodeId: "document" },
      },
      result: { ok: false, error: { code: "conflict", uri: "manuscript://B" } },
    },
  });
  if (!received) throw new Error("Missing receipt");
  const settled = settleNamespaceOutcome(received.next);
  if (!settled) throw new Error("Missing settlement");
  expect(settled.next.intents.map(({ state }) => state)).toEqual(["needs-repair", "cancelled"]);
  validateResourceRecordUpdate(received.next, settled.next);
  const reopened = structuredClone(settled.next);
  expect(projectResourceLocation("project", reopened)).toEqual({ ...source, provisional: false });
  const offered = projectResourceNeedsRepair("project", reopened);
  expect(offered).toEqual({
    intentId: "B",
    kind: "set-location",
    name: "C",
    destination: {
      parent: { kind: "root", scheme: "manuscript", owner: { workId: null } },
      name: "C",
    },
  });
  if (!offered) throw new Error("Missing offered repair");
  // The caller retries the offered destination, keeping the original receipt as evidence.
  const repair = planResourceLocation({
    record: reopened,
    projectId: "project",
    intentId: "repair",
    operationId: "repair",
    eligibleAt: 1,
    destination: {
      parent: { kind: "root", scheme: "manuscript", owner: { workId: null } },
      name: offered.name,
    },
  });
  if (!repair) throw new Error("Missing repair");
  validateResourceRecordUpdate(reopened, repair.next);
  const retry = prepareNamespaceAttempt(
    repair.next,
    { attemptId: "retry", operationId: "repair" },
    (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
  );
  if (!retry) throw new Error("Missing retry");
  expect(retry.next.intents.at(-1)?.attempts[0].request).toMatchObject({
    body: { path: "A", newName: "C" },
  });
  expect(projectResourceNeedsRepair("project", retry.next)).toBeNull();
});

it.each([
  false,
  true,
])("deletes canonical file after an overlapping move refusal (%s)", (receiptless) => {
  const before = local();
  before.resource.canonical = { scheme: "manuscript", path: "/A", name: "A", workId: null };
  before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  before.intents = [];
  const move = planResourceLocation({
    record: before,
    projectId: "project",
    intentId: "move",
    operationId: "move",
    eligibleAt: 1,
    destination: {
      parent: { kind: "root", scheme: "manuscript", owner: { workId: null } },
      name: "B",
    },
  });
  if (!move) throw new Error("Missing move");
  const submitted = prepareNamespaceAttempt(
    move.next,
    {
      attemptId: "attempt",
      operationId: "move",
    },
    (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
  );
  if (!submitted) throw new Error("Missing submission");
  const deletion = planResourceDeletion(submitted.next, "project", "delete");
  if (!deletion) throw new Error("Missing deletion");
  validateResourceRecordUpdate(submitted.next, deletion.next);
  const outcome: NamespaceOutcome = receiptless
    ? {
        kind: "refusal",
        operationId: "move",
        error: {
          code: "work_missing",
          message: "Work not found.",
          source: "system",
          retryable: false,
        },
      }
    : {
        kind: "operation",
        receipt: {
          observationVersion: "1",
          operationId: "move",
          command: {
            destinationParent: {
              kind: "root" as const,
              scheme: "manuscript" as const,
              owner: { workId: null },
            },
            kind: "move",
            sourceUri: "manuscript://A",
            destinationUri: "manuscript://B",
            expected: { kind: "file", nodeId: "document" },
          },
          result: { ok: false, error: { code: "conflict", uri: "manuscript://B" } },
        },
      };
  const received = recordNamespaceOutcome(deletion.next, "move", "attempt", outcome);
  if (!received) throw new Error("Missing refusal");
  const settled = settleNamespaceOutcome(received.next);
  if (!settled) throw new Error("Missing settlement");
  expect(settled.next.intents.map((i) => i.state)).toEqual(["superseded", "pending"]);
  validateResourceRecordUpdate(received.next, settled.next);
  expect(settled.next.intents[0]?.attempts[0]?.outcome).toEqual(outcome);
  const reopened = structuredClone(settled.next);
  expect(projectResourceNeedsRepair("project", reopened)).toBeNull();
  const retry = prepareNamespaceAttempt(
    reopened,
    {
      attemptId: "delete-attempt",
      operationId: "delete",
    },
    (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
  );
  if (!retry) throw new Error("Missing delete dispatch");
  expect(retry.next.intents.at(-1)?.attempts[0]?.request).toMatchObject({
    kind: "delete",
    body: { path: "A", expected: { kind: "file", documentId: "document" } },
  });
});

it("refuses a move receipt for a different captured destination parent", () => {
  const attempt: NamespaceAttempt = {
    attemptId: "attempt",
    request: {
      kind: "move",
      scheme: "manuscript",
      sourceWorkHandle: null,
      destinationWorkHandle: null,
      body: {
        operationId: "operation",
        path: "A",
        expected: { kind: "file", nodeId: "document" },
        destinationScheme: "manuscript",
        destinationFolderPath: "B",
        destinationParent: { kind: "folder", folderId: "selected" },
      },
    },
  };
  const outcome: NamespaceOutcome = {
    kind: "operation",
    receipt: {
      observationVersion: "1",
      operationId: "operation",
      command: {
        kind: "move",
        sourceUri: "manuscript://A",
        destinationUri: "manuscript://B/A",
        expected: { kind: "file", nodeId: "document" },
        destinationParent: { kind: "folder", folderId: "replacement" },
      },
      result: { ok: true, value: { destinationPath: "B/A" } },
    },
  };
  expect(namespaceOutcomeMatches(attempt, outcome)).toBe(false);
  if (outcome.receipt.command.kind !== "move") throw new Error("Expected move receipt");
  outcome.receipt.command.destinationParent = { kind: "folder", folderId: "selected" };
  expect(namespaceOutcomeMatches(attempt, outcome)).toBe(true);
});

it("matches immutable identity moves after the destination's path and owner change", () => {
  const before = local();
  before.resource.canonical = {
    scheme: "unfiled",
    path: "/before",
    name: "before",
    workId: null,
  };
  before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  before.intents = [
    {
      ...before.intents[0],
      intentId: "move",
      desired: {
        kind: "set-location",
        typedName: "before",
        destination: { parent: { kind: "folder", folderId: "parent" }, name: "before" },
      },
    },
  ];
  const submitted = prepareNamespaceAttempt(
    before,
    { attemptId: "attempt", operationId: "operation" },
    () => ({ scheme: "scratch", path: "/B", name: "B", workId: "work", workHandle: "w5" }),
  );
  if (!submitted) throw new Error("Missing attempt");
  expect(() =>
    recordNamespaceOutcome(submitted.next, "move", "attempt", {
      kind: "operation",
      receipt: {
        observationVersion: "1",
        operationId: "operation",
        command: {
          kind: "move",
          sourceUri: "unfiled://before",
          destinationUri: "manuscript://Renamed/before",
          destinationParent: { kind: "folder", folderId: "parent" },
          expected: { kind: "file", nodeId: "document" },
        },
        result: { ok: true, value: { destinationPath: "Renamed/before" } },
      },
    }),
  ).not.toThrow();
});

it("retains a missing-folder suffix in immutable transport and receipt matching", () => {
  const record = local();
  record.resource.canonical = { scheme: "unfiled", path: "/A", name: "A", workId: null };
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  record.intents = [
    {
      ...record.intents[0],
      intentId: "move",
      desired: {
        kind: "set-location",
        typedName: "A",
        destination: {
          parent: { kind: "folder", folderId: "anchor" },
          createFolders: ["New Arc", "Part 1"],
          name: "A",
        },
      },
    },
  ];
  const submitted = prepareNamespaceAttempt(
    record,
    { attemptId: "attempt", operationId: "operation" },
    () => ({ scheme: "manuscript", path: "/Act", name: "Act", workId: null }),
  );
  const attempt = submitted?.next.intents[0].attempts[0];
  if (!attempt) throw new Error("Missing attempt");
  expect(attempt.request).toMatchObject({
    kind: "move",
    body: {
      destinationFolderPath: "Act/New Arc/Part 1",
      destinationParent: {
        kind: "folder",
        folderId: "anchor",
        createFolders: ["New Arc", "Part 1"],
      },
    },
  });
  const outcome: NamespaceOutcome = {
    kind: "operation",
    receipt: {
      observationVersion: "1",
      operationId: "operation",
      command: {
        kind: "move",
        sourceUri: "unfiled://A",
        destinationUri: "kb://Renamed/New Arc/Part 1/A",
        expected: { kind: "file", nodeId: "document" },
        destinationParent: {
          kind: "folder",
          folderId: "anchor",
          createFolders: ["New Arc", "Part 1"],
        },
      },
      result: { ok: true, value: { destinationPath: "Renamed/New Arc/Part 1/A" } },
    },
  };
  expect(namespaceOutcomeMatches(attempt, outcome)).toBe(true);
  if (outcome.receipt.command.kind !== "move") throw new Error("Not a move");
  outcome.receipt.command.destinationParent = {
    kind: "folder",
    folderId: "anchor",
    createFolders: ["Part 1"],
  };
  expect(namespaceOutcomeMatches(attempt, outcome)).toBe(false);
});

describe("a name the writer typed with a prose suffix", () => {
  const moveReceipt = (operationId: string, sourceUri: string, destinationUri: string) =>
    ({
      kind: "operation",
      receipt: {
        observationVersion: "1",
        operationId,
        command: {
          kind: "move",
          sourceUri,
          destinationUri,
          expected: { kind: "file", nodeId: "document" },
          destinationParent: destinationUri.includes("/Book/")
            ? { kind: "folder", folderId: "Book" }
            : { kind: "root", scheme: "manuscript", owner: { workId: null } },
        },
        result: { ok: true, value: { movedNodeId: "document", destinationPath: "x" } },
      },
    }) satisfies NamespaceOutcome;

  function placed(canonicalName: string): ResourceRecord {
    const record = local();
    record.resource.canonical = {
      scheme: "manuscript",
      path: `/${canonicalName}`,
      name: canonicalName,
      workId: null,
    };
    record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    record.intents = [];
    return record;
  }

  function submit(record: ResourceRecord, typed: string, folderPath = "") {
    const planned = planResourceLocation({
      record,
      projectId: "project",
      intentId: "intent",
      operationId: "operation",
      eligibleAt: 1,
      destination: {
        parent: folderPath
          ? { kind: "folder", folderId: "Book" }
          : { kind: "root", scheme: "manuscript", owner: { workId: null } },
        name: typed,
      },
    });
    if (!planned) throw new Error("Missing location command");
    const prepared = prepareNamespaceAttempt(
      planned.next,
      {
        attemptId: "attempt",
        operationId: "operation",
      },
      () => ({ scheme: "manuscript", path: "/Book", name: "Book", workId: null }),
    );
    if (!prepared) throw new Error("Missing submission");
    return prepared.next;
  }

  it("is submitted and projected as the stored name, so the server's receipt is this attempt's", () => {
    const submitted = submit(placed("Chapter 13"), "Chapter 14.md");
    const intent = submitted.intents[0];
    expect(intent?.desired).toMatchObject({ destination: { name: "Chapter 14" } });
    expect(intent?.attempts[0]?.request).toMatchObject({ body: { newName: "Chapter 14.md" } });
    // The optimistic location is already the name the server answers with.
    expect(projectResourceLocation("project", submitted)).toMatchObject({ name: "Chapter 14" });
    const needsRepair = structuredClone(submitted);
    needsRepair.intents = needsRepair.intents.map((item) => ({
      ...item,
      state: "needs-repair",
    }));
    expect(projectResourceNeedsRepair("project", needsRepair)?.name).toBe("Chapter 14.md");
    expect(
      recordNamespaceOutcome(
        submitted,
        "intent",
        "attempt",
        moveReceipt("operation", "manuscript://Chapter 13", "manuscript://Chapter 14.md"),
      ),
    ).not.toBeNull();
  });

  it("moving a document under the name it has, typed with its suffix, asks for no rename", () => {
    const submitted = submit(placed("Chapter 13"), "Chapter 13.md", "Book");
    expect(submitted.intents[0]?.attempts[0]?.request).toMatchObject({
      body: { destinationFolderPath: "Book" },
    });
    expect(submitted.intents[0]?.attempts[0]?.request).toHaveProperty(
      "body.newName",
      "Chapter 13.md",
    );
    expect(
      recordNamespaceOutcome(
        submitted,
        "intent",
        "attempt",
        moveReceipt("operation", "manuscript://Chapter 13", "manuscript://Book/Chapter 13.md"),
      ),
    ).not.toBeNull();
  });

  it("keeps the extension of the file a bare name renames", () => {
    const submitted = submit(placed("config.toml"), "settings");
    expect(submitted.intents[0]?.attempts[0]?.request).toMatchObject({
      body: { newName: "settings" },
    });
  });

  it("is stored for a new document too, with no source name to inherit from", () => {
    const record = local();
    record.intents = [];
    const planned = planResourceLocation({
      record,
      projectId: "project",
      intentId: "intent",
      operationId: "operation",
      eligibleAt: 1,
      destination: {
        parent: { kind: "root", scheme: "manuscript", owner: { workId: null } },
        name: "Chapter 13.md",
      },
    });
    expect(planned?.next.intents[0]?.desired).toMatchObject({
      destination: { name: "Chapter 13" },
    });
  });
});
