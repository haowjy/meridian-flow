/** Durable namespace policy protects request bytes, response-loss recovery and newer intentions. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import { planResourceDeletion } from "./resource-deletion";
import {
  installCanonicalRefresh,
  prepareNamespaceAttempt,
  reconcileResourceNamespace,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "./resource-namespace";
import { projectResourceLocation, projectResourceNeedsRepair } from "./resource-projection";
import type {
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
        desired: { kind: "create", folderPath: "drafts" },
        attempts: [],
        state: "pending",
      },
    ],
  };
}

function createOutcome(name = "Untitled.md"): Extract<NamespaceOutcome, { kind: "create" }> {
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
      prepareNamespaceAttempt(record, {
        attemptId: "attempt",
        operationId: "unused-create-operation",
      }),
    ).toBeNull();
  });

  it("does not dispatch creation before exact local content is initialized", () => {
    const record = local();
    if (record.resource.content.kind !== "exact") throw new Error("Expected exact content");
    record.resource.content.initialization = "reserved";

    expect(
      prepareNamespaceAttempt(record, {
        attemptId: "attempt",
        operationId: "unused-create-operation",
      }),
    ).toBeNull();
  });

  it("persists immutable create request bytes before an outcome can be recorded", () => {
    const before = local();
    const submitted = prepareNamespaceAttempt(before, {
      attemptId: "attempt",
      operationId: "unused-create-operation",
    });
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
        path: "/drafts/Untitled.md",
        name: "Untitled.md",
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
          generation: null,
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
      path: "/drafts/Document.md",
      name: "Document.md",
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
    const submitted = prepareNamespaceAttempt(before, {
      attemptId: "attempt",
      operationId: "operation",
    });
    if (!submitted) throw new Error("missing submitted write");
    const receipt: ContextOperationReceipt = {
      operationId: "operation",
      command: {
        kind: "delete",
        uri: "unfiled://drafts/Document.md",
        expected: { kind: "file", documentId: "document" },
      },
      result: {
        ok: true,
        value: {
          status: "deleted",
          deletedDocumentIds: ["document"],
          availabilityGeneration: "new",
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
      generation: "new",
      transitionId: "operation",
    });
    expect(settled?.next.resource.content).toEqual(before.resource.content);
    expect(settled?.next.resource.canonical).toBeNull();
  });

  it("retains a newer observed canonical location when settling a historical move", () => {
    const before = local();
    before.resource.canonical = {
      scheme: "unfiled",
      path: "/before.md",
      name: "before.md",
      workId: null,
    };
    before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    before.intents = [
      {
        ...before.intents[0],
        intentId: "move",
        desired: {
          kind: "set-location",
          destination: {
            scheme: "manuscript",
            folderPath: "chapters",
            name: "after.md",
            workId: null,
          },
        },
      },
    ];
    const submitted = prepareNamespaceAttempt(before, {
      attemptId: "attempt",
      operationId: "operation",
    });
    if (!submitted) throw new Error("missing submitted write");
    const received = recordNamespaceOutcome(submitted.next, "move", "attempt", {
      kind: "operation",
      receipt: {
        operationId: "operation",
        command: {
          kind: "move",
          sourceUri: "unfiled://before.md",
          destinationUri: "manuscript://chapters/after.md",
          expected: { kind: "file", nodeId: "document" },
        },
        result: {
          ok: true,
          value: { movedNodeId: "document", destinationPath: "chapters/after.md" },
        },
      },
    });
    if (!received) throw new Error("missing received write");
    expect(settleNamespaceOutcome(received.next)?.next.resource.canonical).toEqual(
      before.resource.canonical,
    );
    received.next.resource.canonical = {
      scheme: "manuscript",
      path: "/externally-renamed.md",
      name: "externally-renamed.md",
      workId: null,
    };
    const settled = settleNamespaceOutcome(received.next);
    expect(settled?.next.resource.canonical).toEqual(received.next.resource.canonical);
    expect(settled?.next.intents[0]?.state).toBe("settled");
    expect(settled?.next.resource.obligations.canonicalRefresh).toEqual({
      operationId: "operation",
      identityRevision: 1,
    });
  });

  it("blocks a queued delete until a post-move catalog observation supplies its source", () => {
    const before = local();
    before.resource.canonical = {
      scheme: "unfiled",
      path: "/before.md",
      name: "before.md",
      workId: null,
    };
    before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    before.intents = [
      {
        ...before.intents[0],
        intentId: "move",
        desired: {
          kind: "set-location",
          destination: {
            scheme: "manuscript",
            folderPath: "chapters",
            name: "after.md",
            workId: null,
          },
        },
      },
      {
        ...before.intents[0],
        intentId: "delete",
        sequence: 2,
        desired: { kind: "delete" },
      },
    ];
    const submitted = prepareNamespaceAttempt(before, {
      attemptId: "move-attempt",
      operationId: "move-operation",
    });
    if (!submitted) throw new Error("missing move attempt");
    const received = recordNamespaceOutcome(submitted.next, "move", "move-attempt", {
      kind: "operation",
      receipt: {
        operationId: "move-operation",
        command: {
          kind: "move",
          sourceUri: "unfiled://before.md",
          destinationUri: "manuscript://chapters/after.md",
          expected: { kind: "file", nodeId: "document" },
        },
        result: {
          ok: true,
          value: { movedNodeId: "document", destinationPath: "chapters/after.md" },
        },
      },
    });
    if (!received) throw new Error("missing move outcome");
    const settled = settleNamespaceOutcome(received.next);
    if (!settled) throw new Error("missing move settlement");
    expect(
      prepareNamespaceAttempt(settled.next, {
        attemptId: "delete-attempt",
        operationId: "delete-operation",
      }),
    ).toBeNull();
    const refreshed = installCanonicalRefresh({
      record: settled.next,
      operationId: "move-operation",
      location: {
        scheme: "manuscript",
        path: "/chapters/after.md",
        name: "after.md",
        workId: null,
      },
    });
    if (!refreshed) throw new Error("missing canonical refresh");
    expect(() => validateResourceRecordUpdate(settled.next, refreshed.next)).not.toThrow();
    const deletion = prepareNamespaceAttempt(refreshed.next, {
      attemptId: "delete-attempt",
      operationId: "delete-operation",
    });
    expect(deletion?.next.intents[1]?.attempts[0]?.request).toMatchObject({
      kind: "delete",
      scheme: "manuscript",
      body: { path: "chapters/after.md" },
    });
  });

  it("rejects a receipt for a different immutable source path", () => {
    const before = local();
    before.resource.canonical = {
      scheme: "unfiled",
      path: "/before.md",
      name: "before.md",
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
    const submitted = prepareNamespaceAttempt(before, {
      attemptId: "attempt",
      operationId: "operation",
    });
    if (!submitted) throw new Error("missing submitted write");
    expect(() =>
      recordNamespaceOutcome(submitted.next, "delete", "attempt", {
        kind: "operation",
        receipt: {
          operationId: "operation",
          command: {
            kind: "delete",
            uri: "unfiled://replacement.md",
            expected: { kind: "file", documentId: "document" },
          },
          result: {
            ok: true,
            value: {
              status: "deleted",
              deletedDocumentIds: ["document"],
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
      path: "/note.md",
      name: "note.md",
      workId: "work-a",
      workSlug: "alpha",
    };
    before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    before.intents = [
      {
        ...before.intents[0],
        intentId: "delete",
        desired: { kind: "delete" },
      },
    ];
    const submitted = prepareNamespaceAttempt(before, {
      attemptId: "attempt",
      operationId: "operation",
    });
    if (!submitted) throw new Error("missing submitted write");
    expect(() =>
      recordNamespaceOutcome(submitted.next, "delete", "attempt", {
        kind: "operation",
        receipt: {
          operationId: "operation",
          command: {
            kind: "delete",
            uri: "scratch://@beta/note.md",
            expected: { kind: "file", documentId: "document" },
          },
          result: {
            ok: true,
            value: {
              status: "deleted",
              deletedDocumentIds: ["document"],
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
      path: "/duel/beats.md",
      name: "beats.md",
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
          destination: { scheme: "manuscript", folderPath: "", name: "beats.md", workId: null },
        },
      },
    ];
    const submitted = prepareNamespaceAttempt(record, {
      attemptId: "attempt",
      operationId: "operation",
    });
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
    const submitted = prepareNamespaceAttempt(record, {
      attemptId: "attempt",
      operationId: "operation",
    });
    if (!submitted) throw new Error("missing submitted write");
    const receipt = (uri: string): NamespaceOutcome => ({
      kind: "operation",
      receipt: {
        operationId: "operation",
        command: { kind: "delete", uri, expected: { kind: "file", documentId: "document" } },
        result: {
          ok: true,
          value: {
            status: "deleted",
            deletedDocumentIds: ["document"],
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
        receipt("scratch://@/c12/duel/beats.md"),
      ),
    ).not.toThrow();
    expect(() =>
      recordNamespaceOutcome(
        submitted.next,
        "delete",
        "attempt",
        receipt("scratch://@/c40/duel/beats.md"),
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
    const submitted = prepareNamespaceAttempt(store.record, {
      attemptId: "attempt",
      operationId: "operation",
    });
    if (!submitted) throw new Error("missing submitted write");
    store.record = submitted.next;
    const read = vi.fn(async () => null);
    const submit = vi.fn(async () => ({
      kind: "create" as const,
      result: {
        status: "already-materialized" as const,
        documentId: "document",
        scheme: "unfiled" as const,
        path: "/drafts/Untitled.md",
        name: "Untitled.md",
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
    const submitted = prepareNamespaceAttempt(store.record, {
      attemptId: "attempt",
      operationId: "operation",
    });
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
    path: "/before.md",
    name: "before.md",
    workId: "work",
    workSlug: "notes",
  };
  before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  before.intents = [
    {
      ...before.intents[0],
      intentId: "move",
      desired: {
        kind: "set-location",
        destination: {
          scheme: "scratch",
          folderPath: "",
          name: "after.md",
          workId: "work",
          workSlug: "notes",
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
                operationId: "operation",
                command: {
                  kind: "move",
                  sourceUri: "scratch://@notes/before.md",
                  destinationUri: "scratch://@notes/after.md",
                  expected: { kind: "file", nodeId: "document" },
                },
                result: {
                  ok: false,
                  error: {
                    code: "context_unavailable",
                    reason,
                    workSlug: "notes",
                    uri: "scratch://@notes/after.md",
                  },
                },
              },
            },
    }),
  });
  expect(result).toBe("needs-repair");
  expect(store.record.resource.identity.documentId).toBe("document");
  expect(projectResourceLocation("project", store.record)?.path).toBe("/before.md");
  expect(projectResourceNeedsRepair("project", store.record)).toEqual({
    intentId: "move",
    kind: "set-location",
    name: "after.md",
    destination: {
      scheme: "scratch",
      folderPath: "",
      name: "after.md",
      workId: "work",
      workSlug: "notes",
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
            operationId: "delete-operation",
            command: {
              kind: "delete",
              uri: "scratch://@notes/before.md",
              expected: { kind: "file", documentId: "document" },
            },
            result: { ok: false, error: { code: "conflict", uri: "scratch://@notes/before.md" } },
          },
        }),
      }),
    }),
  ).toBe("needs-repair");
  expect(projectResourceLocation("project", store.record)?.path).toBe("/before.md");
  expect(projectResourceNeedsRepair("project", store.record)?.kind).toBe("delete");
});

it("restores a rejected delete after retry and admits another delete", async () => {
  const before = local();
  before.resource.canonical = {
    scheme: "scratch",
    path: "/note.md",
    name: "note.md",
    workId: "work",
    workSlug: "alpha",
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
              operationId: `operation-${number}`,
              command: {
                kind: "delete",
                uri: "scratch://@alpha/note.md",
                expected: { kind: "file", documentId: "document" },
              },
              result: { ok: false, error: { code: "conflict", uri: "scratch://@alpha/note.md" } },
            },
          }),
        }),
      }),
    ).toBe("needs-repair");
    expect(projectResourceLocation("project", store.record)?.path).toBe("/note.md");
  }
  expect(planResourceDeletion(store.record, "project", "delete-3")).not.toBeNull();
});

it("offers the latest queued file name after refusal and retries from accepted placement", () => {
  const before = local();
  const source = { scheme: "manuscript" as const, path: "/A.md", name: "A.md", workId: null };
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
      destination: { scheme: "manuscript", folderPath: "", name, workId: null },
    });
    if (!write) throw new Error("Missing location command");
    validateResourceRecordUpdate(record, write.next);
    return write.next;
  };
  const renamed = location(before, "B.md");
  const submitted = prepareNamespaceAttempt(renamed, { attemptId: "attempt", operationId: "B.md" });
  if (!submitted) throw new Error("Missing submission");
  const queued = location(submitted.next, "C.md");
  const received = recordNamespaceOutcome(queued, "B.md", "attempt", {
    kind: "operation",
    receipt: {
      operationId: "B.md",
      command: {
        kind: "move",
        sourceUri: "manuscript://A.md",
        destinationUri: "manuscript://B.md",
        expected: { kind: "file", nodeId: "document" },
      },
      result: { ok: false, error: { code: "conflict", uri: "manuscript://B.md" } },
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
    intentId: "B.md",
    kind: "set-location",
    name: "C.md",
    destination: { scheme: "manuscript", folderPath: "", name: "C.md", workId: null },
  });
  if (!offered) throw new Error("Missing offered repair");
  // The caller retries the offered destination, keeping the original receipt as evidence.
  const repair = planResourceLocation({
    record: reopened,
    projectId: "project",
    intentId: "repair",
    operationId: "repair",
    eligibleAt: 1,
    destination: { scheme: "manuscript", folderPath: "", name: offered.name, workId: null },
  });
  if (!repair) throw new Error("Missing repair");
  validateResourceRecordUpdate(reopened, repair.next);
  const retry = prepareNamespaceAttempt(repair.next, { attemptId: "retry", operationId: "repair" });
  if (!retry) throw new Error("Missing retry");
  expect(retry.next.intents.at(-1)?.attempts[0].request).toMatchObject({
    body: { path: "A.md", newName: "C.md" },
  });
  expect(projectResourceNeedsRepair("project", retry.next)).toBeNull();
});
