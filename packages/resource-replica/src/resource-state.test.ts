import { expect, it } from "vitest";
import {
  prepareNamespaceAttempt,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "./resource-namespace";
import { validateResourceRecordUpdate } from "./resource-records-policy";
import {
  acknowledgeResourceTerminalCleanup,
  acknowledgeSessionAdoption,
  markResourceCreateEligible,
  planCachedSessionAdoption,
  planResourceLocation,
  planSessionAdoptionGeneration,
  publishResourceTerminal,
  recordAcquiredResourceContent,
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

it("records a live server cache once and leaves its adoption witness stable", () => {
  const record = reserved();
  record.resource.content = { kind: "unacquired" };
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "6" };
  record.resource.canonical = {
    scheme: "manuscript",
    path: "/chapter.md",
    name: "chapter.md",
    workId: null,
  };
  record.resource.obligations = {};
  record.intents = [];

  const acquired = recordAcquiredResourceContent({
    record,
    projectId: "project",
    documentId: "document-a",
    databaseName: "server-cache",
    schema: "schema",
    generation: "7",
    transitionId: "acquire-7",
  });
  if (!acquired) throw new Error("Expected acquired cache transition");
  validateResourceRecordUpdate(record, acquired.next);
  expect(acquired.next.resource).toMatchObject({
    content: { kind: "exact", databaseName: "server-cache", schema: "schema" },
    lifecycle: { kind: "acknowledged", availabilityGeneration: "7" },
    obligations: {
      sessionAdoption: {
        transitionId: "acquire-7",
        projectId: "project",
        generation: "7",
      },
    },
  });

  expect(
    recordAcquiredResourceContent({
      record: acquired.next,
      projectId: "project",
      documentId: "document-a",
      databaseName: "server-cache",
      schema: "schema",
      generation: "7",
      transitionId: "replacement-must-not-win",
    }),
  ).toBeNull();
});

it("rejects server content captured for an obsolete resource identity", () => {
  const record = reserved();
  record.resource.identity = { documentId: "replacement", revision: 2 };
  record.resource.content = { kind: "unacquired" };
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "6" };
  record.resource.obligations = {};

  expect(() =>
    recordAcquiredResourceContent({
      record,
      projectId: "project",
      documentId: "requested",
      databaseName: "server-cache",
      schema: "schema",
      generation: "7",
      transitionId: "acquire-7",
    }),
  ).toThrow("current resource identity");
});

it("publishes and acknowledges exact terminal cleanup without removing recovery history", () => {
  const record = reserved();
  if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
  const terminal = publishResourceTerminal({
    record,
    documentId: "document-a",
    generation: "9",
    transitionId: "delete-9",
    exactDatabaseName: "database",
  });
  if (!terminal) throw new Error("Expected terminal transition");
  validateResourceRecordUpdate(record, terminal.next);
  expect(terminal.next.resource).toMatchObject({
    canonical: null,
    lifecycle: { kind: "terminal", generation: "9", transitionId: "delete-9" },
    obligations: {
      cleanup: { obligationId: "delete-9", exactDatabaseName: "database" },
    },
  });
  const acknowledged = acknowledgeResourceTerminalCleanup({
    record: terminal.next,
    generation: "9",
    transitionId: "delete-9",
    exactDatabaseName: "database",
  });
  if (!acknowledged) throw new Error("Expected cleanup acknowledgement");
  validateResourceRecordUpdate(terminal.next, acknowledged.next);
  expect(acknowledged.next.resource.obligations).toEqual({});
  expect(acknowledged.next.intents).toEqual(record.intents);
});

it("hands same-generation namespace terminal evidence to the session cleanup transition", () => {
  const record = reserved();
  if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
  record.resource.lifecycle = {
    kind: "terminal",
    generation: "9",
    transitionId: "namespace-operation",
  };

  const handedOff = publishResourceTerminal({
    record,
    documentId: "document-a",
    generation: "9",
    transitionId: "session-drain",
    exactDatabaseName: "database",
  });

  expect(handedOff?.next.resource).toMatchObject({
    lifecycle: { kind: "terminal", generation: "9", transitionId: "session-drain" },
    obligations: {
      cleanup: { obligationId: "session-drain", exactDatabaseName: "database" },
    },
  });
  if (!handedOff) throw new Error("Expected terminal handoff");
  expect(() => validateResourceRecordUpdate(record, handedOff.next)).not.toThrow();
});

it("preserves the first create-eligibility witness when filing later", () => {
  const eligible = markResourceCreateEligible(reserved(), 1);
  if (!eligible) throw new Error("Expected create eligibility");
  const placed = planResourceLocation({
    record: eligible.next,
    projectId: "project",
    intentId: "move",
    eligibleAt: 2,
    destination: {
      scheme: "manuscript",
      folderPath: "chapters",
      name: "opening.md",
      workId: null,
    },
  });
  if (!placed) throw new Error("Expected placement");

  validateResourceRecordUpdate(eligible.next, placed.next);
  expect(placed.next.resource.obligations.createEligibility).toEqual({ eligibleAt: 1 });
});

it("remints a received create conflict while retaining exact content and attempt history", () => {
  const record = reserved();
  if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
  const eligible = markResourceCreateEligible(record, 1);
  if (!eligible) throw new Error("Expected create eligibility");
  const attempt = prepareNamespaceAttempt(eligible.next, {
    attemptId: "attempt",
    operationId: "unused",
  });
  if (!attempt) throw new Error("Expected create attempt");
  const received = recordNamespaceOutcome(attempt.next, "create-a", "attempt", {
    kind: "create",
    result: { status: "conflict" },
  });
  if (!received) throw new Error("Expected conflict outcome");
  const failed = settleNamespaceOutcome(received.next);
  if (!failed) throw new Error("Expected persisted conflict outcome");

  const reminted = remintCreateConflict({
    record: failed.next,
    documentId: "document-b",
    retryIntentId: "create-b",
    rebasedIntentIds: {},
  });
  if (!reminted) throw new Error("Expected remint");
  validateResourceRecordUpdate(failed.next, reminted.next);

  expect(reminted.next.resource).toMatchObject({
    identity: { documentId: "document-b", revision: 2 },
    content: { kind: "exact", databaseName: "database" },
    aliases: {
      "document-a": {
        introducedAtIdentityRevision: 2,
      },
    },
  });
  expect(reminted.next.intents).toMatchObject([
    { intentId: "create-a", state: "superseded", attempts: [{ outcome: { kind: "create" } }] },
    { intentId: "create-b", state: "pending", identityRevision: 2, attempts: [] },
  ]);
});

it("rebases queued placement behind the retry when creation remints", () => {
  const record = reserved();
  if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
  const eligible = markResourceCreateEligible(record, 1);
  if (!eligible) throw new Error("Expected create eligibility");
  const attempt = prepareNamespaceAttempt(eligible.next, {
    attemptId: "attempt",
    operationId: "unused",
  });
  if (!attempt) throw new Error("Expected create attempt");
  const withPlacement = planResourceLocation({
    record: attempt.next,
    projectId: "project",
    intentId: "place-a",
    eligibleAt: 1,
    destination: {
      scheme: "manuscript",
      folderPath: "chapters",
      name: "opening.md",
      workId: null,
    },
  });
  if (!withPlacement) throw new Error("Expected placement");
  const received = recordNamespaceOutcome(withPlacement.next, "create-a", "attempt", {
    kind: "create",
    result: { status: "conflict" },
  });
  if (!received) throw new Error("Expected conflict outcome");

  const reminted = remintCreateConflict({
    record: received.next,
    documentId: "document-b",
    retryIntentId: "create-b",
    rebasedIntentIds: { "place-a": "place-b" },
  });
  if (!reminted) throw new Error("Expected remint");
  validateResourceRecordUpdate(received.next, reminted.next);
  expect(reminted.next.intents).toMatchObject([
    { intentId: "create-a", state: "superseded", identityRevision: 1 },
    { intentId: "place-a", state: "cancelled", identityRevision: 1 },
    { intentId: "create-b", state: "pending", identityRevision: 2 },
    { intentId: "place-b", state: "pending", identityRevision: 2 },
  ]);
  expect(
    prepareNamespaceAttempt(reminted.next, {
      attemptId: "retry",
      operationId: "unused",
    })?.next.intents.find((intent) => intent.intentId === "create-b"),
  ).toMatchObject({ state: "submitted" });
});

it("pins and acknowledges one immutable session-adoption generation", () => {
  const record = reserved();
  if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
  const eligible = markResourceCreateEligible(record, 1);
  if (!eligible) throw new Error("Expected create eligibility");
  const attempt = prepareNamespaceAttempt(eligible.next, {
    attemptId: "attempt",
    operationId: "unused",
  });
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
    "requires created or acquired exact content",
  );
  expect(() => planSessionAdoptionGeneration(adopted.next, "")).toThrow(
    "Invalid availability generation",
  );
});

it("starts a fresh adoption witness for an acknowledged exact cache", () => {
  const record = reserved();
  if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "6" };
  record.resource.obligations = {};
  record.intents = [];

  const adoption = planCachedSessionAdoption({
    record,
    projectId: "project",
    transitionId: "reopen-7",
  });
  if (!adoption) throw new Error("Expected cached adoption");
  validateResourceRecordUpdate(record, adoption.next);
  expect(adoption.next.resource.obligations.sessionAdoption).toMatchObject({
    transitionId: "reopen-7",
    generation: null,
  });
});
