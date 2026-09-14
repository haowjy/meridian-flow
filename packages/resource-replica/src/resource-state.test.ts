import { expect, it } from "vitest";
import {
  prepareNamespaceAttempt,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "./resource-namespace";
import { validateResourceRecordUpdate } from "./resource-records-policy";
import {
  acknowledgeSessionAdoption,
  planResourceLocation,
  planSessionAdoptionGeneration,
  remintCreateConflict,
  reserveResourceDocument,
} from "./resource-state";

function reserved() {
  return reserveResourceDocument({
    projectId: "project",
    handle: "handle",
    documentId: "document-a",
    databaseName: "database",
    schema: "schema",
    intentId: "create-a",
  }).next;
}

it("reserves exact local content and its project create intention together", () => {
  expect(reserved()).toMatchObject({
    resource: {
      handle: "handle",
      revision: 1,
      identity: { documentId: "document-a", revision: 1 },
      content: { kind: "exact", databaseName: "database", initialization: "reserved" },
      lifecycle: { kind: "local" },
    },
    intents: [
      {
        projectId: "project",
        intentId: "create-a",
        desired: { kind: "create", folderPath: "" },
      },
    ],
  });
});

it("queues placement after creation without replacing recorded work", () => {
  const record = reserved();
  const write = planResourceLocation({
    record,
    projectId: "project",
    intentId: "move",
    destination: {
      scheme: "manuscript",
      folderPath: "chapters",
      name: "opening.md",
      workId: null,
    },
  });

  expect(write?.next.intents).toHaveLength(2);
  expect(write?.next.intents[0]).toEqual(record.intents[0]);
  expect(write?.next.intents[1]).toMatchObject({
    sequence: 2,
    identityRevision: 1,
    desired: { kind: "set-location" },
  });
});

it("remints a received create conflict while retaining exact content and attempt history", () => {
  const record = reserved();
  if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
  const attempt = prepareNamespaceAttempt(record, { attemptId: "attempt", operationId: "unused" });
  if (!attempt) throw new Error("Expected create attempt");
  const received = recordNamespaceOutcome(attempt.next, "create-a", "attempt", {
    kind: "create",
    result: { status: "conflict" },
  });
  if (!received) throw new Error("Expected conflict outcome");

  const reminted = remintCreateConflict({
    record: received.next,
    documentId: "document-b",
    retryIntentId: "create-b",
    publicationObligationId: "publish-a",
  });
  if (!reminted) throw new Error("Expected remint");
  validateResourceRecordUpdate(received.next, reminted.next);

  expect(reminted.next.resource).toMatchObject({
    identity: { documentId: "document-b", revision: 2 },
    content: { kind: "exact", databaseName: "database" },
    aliases: {
      "document-a": {
        publicationObligationId: "publish-a",
        introducedAtIdentityRevision: 2,
      },
    },
  });
  expect(reminted.next.intents).toMatchObject([
    { intentId: "create-a", state: "settled", attempts: [{ outcome: { kind: "create" } }] },
    { intentId: "create-b", state: "pending", identityRevision: 2, attempts: [] },
  ]);
});

it("pins and acknowledges one immutable session-adoption generation", () => {
  const record = reserved();
  if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
  const attempt = prepareNamespaceAttempt(record, { attemptId: "attempt", operationId: "unused" });
  if (!attempt) throw new Error("Expected create attempt");
  const received = recordNamespaceOutcome(attempt.next, "create-a", "attempt", {
    kind: "create",
    result: {
      status: "created",
      documentId: "document-a",
      scheme: "unfiled",
      path: "/Untitled.md",
      name: "Untitled.md",
    },
  });
  const adopted = received && settleNamespaceOutcome(received.next);
  if (!adopted) throw new Error("Expected adoption obligation");
  const pinned = planSessionAdoptionGeneration(adopted.next, "7");
  if (!pinned) throw new Error("Expected generation pin");
  validateResourceRecordUpdate(adopted.next, pinned.next);
  expect(() => planSessionAdoptionGeneration(pinned.next, "8")).toThrow("immutable");
  const acknowledged = acknowledgeSessionAdoption(pinned.next);
  if (!acknowledged) throw new Error("Expected adoption acknowledgement");
  validateResourceRecordUpdate(pinned.next, acknowledged.next);
  expect(acknowledged.next.resource).toMatchObject({
    lifecycle: { kind: "acknowledged", availabilityGeneration: "7" },
    obligations: {},
  });
  const replayed = structuredClone(acknowledged.next);
  replayed.resource.revision += 1;
  replayed.resource.obligations.sessionAdoption = {
    ...(pinned.next.resource.obligations.sessionAdoption as NonNullable<
      typeof pinned.next.resource.obligations.sessionAdoption
    >),
    generation: null,
  };
  expect(() => validateResourceRecordUpdate(acknowledged.next, replayed)).toThrow(
    "before its first authority generation",
  );
  expect(() => planSessionAdoptionGeneration(adopted.next, "")).toThrow(
    "Invalid availability generation",
  );
});
