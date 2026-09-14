/** Durable namespace policy protects request bytes, response-loss recovery and newer intentions. */
import type { ContextOperationReceipt } from "@meridian/contracts/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  installCanonicalRefresh,
  prepareNamespaceAttempt,
  reconcileResourceNamespace,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "./resource-namespace";
import type {
  NamespaceOutcome,
  ResourceMetadataStore,
  ResourceNamespaceTransport,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";
import { validateResourceRecordUpdate } from "./resource-records-policy";

function local(): ResourceRecord {
  return {
    resource: {
      handle: "resource",
      revision: 1,
      identity: { documentId: "document", revision: 1 },
      content: { kind: "exact", databaseName: "content", schema: null },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: {},
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
    });
    expect(settled?.next.intents[0]?.state).toBe("settled");
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

  it("leaves an old submitted request uncertain after identity remint", async () => {
    const store = new MemoryStore();
    const submitted = prepareNamespaceAttempt(store.record, {
      attemptId: "attempt",
      operationId: "operation",
    });
    if (!submitted) throw new Error("missing submitted write");
    store.record = submitted.next;
    store.record.resource.identity = { documentId: "replacement", revision: 2 };
    const submit = vi.fn(async () => createOutcome());
    await expect(
      reconcileResourceNamespace({
        key: store.record.resource,
        metadata: asMetadata(store),
        lock: immediateLock,
        transport: transport({ submit }),
        newAttemptIds: () => ({ attemptId: "unused", operationId: "unused" }),
      }),
    ).resolves.toBe("uncertain");
    expect(submit).not.toHaveBeenCalled();
    expect(store.record.intents[0]?.state).toBe("submitted");
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
