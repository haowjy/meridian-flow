import { expect, it } from "vitest";
import {
  prepareNamespaceAttempt,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "./resource-namespace";
import { projectResourceLocation, projectResourceNeedsRepair } from "./resource-projection";
import { validateResourceRecordUpdate } from "./resource-records-policy";
import {
  acknowledgeResourceTerminalCleanup,
  acknowledgeSessionAdoption,
  markResourceCreateEligible,
  planCachedSessionAdoption,
  planResourceLocation,
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
    deletionVersion: "4",
  });
  if (!terminal) throw new Error("Expected terminal transition");
  validateResourceRecordUpdate(record, terminal.next);
  expect(terminal.next.resource).toMatchObject({
    canonical: null,
    lifecycle: {
      kind: "terminal",
      generation: "9",
      transitionId: "delete-9",
      deletionVersion: "4",
    },
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
    deletionVersion: "6",
  };

  const handedOff = publishResourceTerminal({
    record,
    documentId: "document-a",
    generation: "9",
    transitionId: "session-drain",
    exactDatabaseName: "database",
    deletionVersion: "5",
  });

  expect(handedOff?.next.resource).toMatchObject({
    lifecycle: {
      kind: "terminal",
      generation: "9",
      transitionId: "session-drain",
      deletionVersion: "6",
    },
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
    destination: { parent: { kind: "folder", folderId: "chapters" }, name: "opening.md" },
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
    destination: { parent: { kind: "folder", folderId: "chapters" }, name: "opening.md" },
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

it("acknowledges a session adoption with the committed incarnation generation", () => {
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
  const acknowledged = acknowledgeSessionAdoption(adopted.next, "7");
  if (!acknowledged) throw new Error("Expected adoption acknowledgement");
  validateResourceRecordUpdate(adopted.next, acknowledged.next);
  expect(acknowledged.next.resource).toMatchObject({
    lifecycle: { kind: "acknowledged", availabilityGeneration: "7" },
    obligations: {},
  });
  expect(() => acknowledgeSessionAdoption(adopted.next, "")).toThrow(
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
  });
});

it("keeps typed rename provenance through optimistic placement and transport", () => {
  for (const typed of ["settings.md", "settings.txt", "Notes.md"]) {
    const record = reserved();
    record.intents = [];
    record.resource.canonical = {
      scheme: "manuscript",
      path: "/Book/config.toml",
      name: "config.toml",
      workId: null,
    };
    const planned = planResourceLocation({
      record,
      projectId: "project",
      intentId: "rename",
      eligibleAt: 0,
      destination: { parent: { kind: "folder", folderId: "Book" }, name: typed },
    });
    expect(planned?.next.intents[0]?.desired).toMatchObject({
      typedName: typed,
      destination: { name: typed === "Notes.md" ? "Notes" : "settings" },
    });
    if (!planned) throw new Error("Missing location plan");
    expect(
      projectResourceLocation("project", planned.next, () => ({
        scheme: "manuscript",
        path: "/Book",
        name: "Book",
        workId: null,
      }))?.name,
    ).toBe(typed === "Notes.md" ? "Notes" : "settings");
    planned.next.intents = planned.next.intents.map((intent) => ({
      ...intent,
      state: "needs-repair",
    }));
    expect(projectResourceNeedsRepair("project", planned.next)?.name).toBe(typed);
    planned.next.intents = planned.next.intents.map((intent) => ({ ...intent, state: "pending" }));
    const attempt = prepareNamespaceAttempt(
      planned.next,
      {
        attemptId: "attempt",
        operationId: "operation",
      },
      () => ({ scheme: "manuscript", path: "/Book", name: "Book", workId: null }),
    );
    expect(attempt?.next.intents[0]?.attempts[0]?.request).toMatchObject({
      kind: "move",
      scheme: "manuscript",
      body: {
        operationId: "operation",
        path: "Book/config.toml",
        expected: { kind: "file", nodeId: record.resource.identity.documentId },
        destinationScheme: "manuscript",
        destinationFolderPath: "Book",
        newName: typed,
      },
    });
  }
});

it("inherits from the locally visible name when a second rename precedes settlement", () => {
  const record = reserved();
  record.intents = [];
  record.resource.canonical = {
    scheme: "user",
    path: "/config.toml",
    name: "config.toml",
    workId: null,
  };
  const prose = planResourceLocation({
    record,
    projectId: "project",
    intentId: "prose",
    eligibleAt: 0,
    destination: {
      parent: { kind: "root", scheme: "user", owner: { workId: null } },
      name: "settings.md",
    },
  });
  if (!prose) throw new Error("Missing first rename");
  const next = planResourceLocation({
    record: prose.next,
    projectId: "project",
    intentId: "next",
    eligibleAt: 0,
    destination: {
      parent: { kind: "root", scheme: "user", owner: { workId: null } },
      name: "Notes",
    },
  });
  expect(next?.next.intents.at(-1)?.desired).toMatchObject({
    typedName: "Notes",
    destination: { name: "Notes" },
  });
});
