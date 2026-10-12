// @vitest-environment jsdom
/** Feedback survives actual account projection replay and identity-conflict journal rebasing. */
import "fake-indexeddb/auto";
import {
  markResourceCreateEligible,
  planFolderLocation,
  planResourceLocation,
  prepareNamespaceAttempt,
  type ResourceRecord,
  recordNamespaceOutcome,
  remintCreateConflict,
  reserveResourceDocument,
  settleNamespaceOutcome,
} from "@meridian/resource-replica";
import { expect, it } from "vitest";
import { createAccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import { AccountResourceReplica } from "@/core/resources/account-resource-replica";
import { IndexedDbResourceMetadata } from "@/core/resources/indexeddb-resource-metadata";
import { deleteIndexedDb } from "@/core/resources/test-support/delete-indexed-db";
import { RenameOperationLifecycle } from "./rename-operation-lifecycle";

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected a journal transition");
  return value;
}

const destination = { parent: { kind: "folder" as const, folderId: "Book" }, name: "new.md" };
const receipt = {
  observationVersion: "1",
  operationId: "move",
  command: {
    kind: "move" as const,
    sourceUri: "manuscript://old.md",
    destinationUri: "manuscript://Book/new.md",
    destinationParent: destination.parent,
    expected: { kind: "file" as const, nodeId: "entry" },
  },
  result: { ok: true as const, value: { destinationPath: "Book/new.md" } },
};
async function fixture(
  run: (
    replica: AccountResourceReplica,
    metadata: IndexedDbResourceMetadata,
    store: RenameOperationLifecycle,
  ) => Promise<void>,
) {
  const accountId = crypto.randomUUID();
  const runtime = createAccountDocumentSessionRuntime({ accountId });
  const replica = new AccountResourceReplica(accountId, runtime);
  const metadata = new IndexedDbResourceMetadata(accountId, () => {});
  const store = new RenameOperationLifecycle(replica);
  try {
    await run(replica, metadata, store);
  } finally {
    store.dispose();
    replica.beginClose();
    metadata.beginClose();
    await replica.finishClose();
    await metadata.finishClose();
    await deleteIndexedDb(`meridian:resource-metadata:v4:${encodeURIComponent(accountId)}`);
  }
}
function withReceipt(record: ResourceRecord): ResourceRecord {
  const prepared = required(
    prepareNamespaceAttempt(
      record,
      {
        attemptId: "move-attempt",
        operationId: "move",
      },
      (id) => ({ scheme: "manuscript", path: `/${id}`, name: id, workId: null }),
    ),
  ).next;
  const moving = required(
    prepared.intents.find(
      (intent) => intent.operationId === "move" && intent.state === "submitted",
    ),
  );
  const received = required(
    recordNamespaceOutcome(prepared, moving.intentId, "move-attempt", {
      kind: "operation",
      receipt: {
        ...receipt,
        command: {
          ...receipt.command,
          sourceUri: "unfiled://old.md",
          expected: { kind: "file", nodeId: "new-id" },
        },
      },
    }),
  ).next;
  return {
    ...received,
    intents: received.intents.map((intent) =>
      intent.intentId === moving.intentId
        ? { ...intent, state: "settled", settledAt: Date.now() }
        : intent,
    ),
  };
}
it("shows the first folder move after cached missing-record replay and a fresh receipt", async () => {
  await fixture(async (replica, metadata, store) => {
    let primed = false;
    const stop = replica.observeProjection(
      "project",
      () => {
        primed = true;
      },
      (error) => {
        throw error;
      },
    );
    await expect.poll(() => primed).toBe(true);
    const write = required(
      planFolderLocation({
        projectId: "project",
        handle: "folder:folder",
        folderId: "folder",
        source: { scheme: "manuscript", path: "/old", name: "old", workId: null },
        intentId: "folder-move",
        operationId: "move",
        destination,
      }),
    );
    // Admission commits before the reactive projection observes the new folder.
    await metadata.commitFolder(write);
    await store.remember("project", { kind: "folder", id: "folder" }, "move");
    await Promise.resolve();
    expect(store.get("project", { kind: "folder", id: "folder" })?.operationId).toBe("move");
    const next = {
      ...write.next,
      revision: write.next.revision + 1,
      intents: write.next.intents.map((intent) => ({
        ...intent,
        state: "settled" as const,
        settledAt: Date.now(),
        attempts: [
          {
            attemptId: "attempt",
            request: {
              kind: "move" as const,
              scheme: "manuscript" as const,
              sourceWorkSlug: null,
              destinationWorkSlug: null,
              body: {
                operationId: "move",
                path: "old",
                expected: { kind: "folder" as const, nodeId: "folder" },
                destinationScheme: "manuscript" as const,
                destinationFolderPath: "Book",
              },
            },
            outcome: {
              kind: "operation" as const,
              receipt: {
                ...receipt,
                command: {
                  ...receipt.command,
                  expected: { kind: "folder" as const, nodeId: "folder" },
                },
              },
            },
          },
        ],
      })),
    };
    await metadata.commitFolder({ expectedRevision: write.next.revision, next });
    await expect
      .poll(
        () => store.get("project", { kind: "folder", id: "folder" })?.feedback?.receipt.operationId,
      )
      .toBe("move");
    stop();
  });
});
it("presents a rebased move receipt at the reminted identity using real remint output", async () => {
  await fixture(async (_replica, metadata, store) => {
    const reserved = reserveResourceDocument({
      projectId: "project",
      handle: "handle",
      documentId: "old-id",
      databaseName: "unused",
      schema: "schema",
      intentId: "create",
    });
    if (reserved.next.resource.content.kind === "exact")
      delete reserved.next.resource.content.initialization;
    const eligible = required(markResourceCreateEligible(reserved.next, 1));
    const create = required(
      prepareNamespaceAttempt(eligible.next, {
        attemptId: "create-attempt",
        operationId: "unused",
      }),
    );
    const placement = required(
      planResourceLocation({
        record: create.next,
        projectId: "project",
        intentId: "placement",
        operationId: "move",
        eligibleAt: 1,
        destination,
      }),
    );
    const conflict = required(
      recordNamespaceOutcome(placement.next, "create", "create-attempt", {
        kind: "create",
        result: { status: "conflict" },
      }),
    );
    conflict.next.resource.revision = 1;
    await metadata.commitResource({ expectedRevision: null, next: conflict.next });
    await store.remember("project", { kind: "file", id: "old-id" }, "move");
    const reminted = required(
      remintCreateConflict({
        record: conflict.next,
        documentId: "new-id",
        retryIntentId: "retry",
        rebasedIntentIds: { placement: "rebased-placement" },
      }),
    );
    await metadata.commitResource(reminted);
    await expect
      .poll(() => store.get("project", { kind: "file", id: "new-id" })?.operationId)
      .toBe("move");
    // Acknowledge the retried create so the real move preparation can progress.
    const retry = required(
      prepareNamespaceAttempt(reminted.next, {
        attemptId: "retry-attempt",
        operationId: "unused",
      }),
    );
    const created = required(
      recordNamespaceOutcome(retry.next, "retry", "retry-attempt", {
        kind: "create",
        result: {
          status: "created",
          documentId: "new-id",
          scheme: "unfiled",
          path: "/old.md",
          name: "old.md",
        },
      }),
    );
    const ready = required(settleNamespaceOutcome(created.next)).next;
    ready.resource.revision = reminted.next.resource.revision + 1;
    await metadata.commitResource({
      expectedRevision: reminted.next.resource.revision,
      next: ready,
    });
    const next = withReceipt(ready);
    next.resource.revision = ready.resource.revision + 1;
    await metadata.commitResource({ expectedRevision: ready.resource.revision, next });
    await expect
      .poll(
        () => store.get("project", { kind: "file", id: "new-id" })?.feedback?.receipt.operationId,
      )
      .toBe("move");
  });
});
