/** Resource-record state transitions protect the one-shot local content reservation.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - One-shot exact-content reservation lifecycle
 */
import { expect, it } from "vitest";
import {
  LOCAL_DELETION_UNDO_MS,
  planLocalDeletionUndo,
  planResourceDeletion,
} from "./resource-deletion";
import { prepareNamespaceAttempt } from "./resource-namespace";
import type { ResourceRecord } from "./resource-records";
import { validateResourceRecordUpdate } from "./resource-records-policy";
import { resourceContextAuthority, resourceWorkAuthorityFor } from "./resource-work-authority";

function reserved(): ResourceRecord {
  return {
    resource: {
      handle: "resource",
      revision: 1,
      identity: { documentId: "document", revision: 1 },
      content: {
        kind: "exact",
        databaseName: "exact-content",
        schema: null,
        initialization: "reserved",
      },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      materialization: { kind: "untitled", folderPath: "", provisionalName: "Untitled" },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: { createEligibility: { eligibleAt: null } },
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

it("requires explicit monotonic eligibility for executable local creation", () => {
  const missing = reserved();
  missing.resource.obligations = {};
  expect(() => validateResourceRecordUpdate(null, missing)).toThrow(
    "requires an explicit eligibility witness",
  );

  const eligible = reserved();
  eligible.resource.obligations.createEligibility = { eligibleAt: 1 };
  const reset = structuredClone(eligible);
  reset.resource.revision = 2;
  reset.resource.obligations.createEligibility = { eligibleAt: 2 };
  expect(() => validateResourceRecordUpdate(eligible, reset)).toThrow("cannot be reset");
});

it("preserves a reservation through local metadata progress but blocks unsafe authority", () => {
  const existing = reserved();
  const continued = structuredClone(existing);
  continued.resource.revision = 2;
  continued.resource.aliases = {
    "/old": { introducedAtIdentityRevision: 1 },
  };
  expect(() => validateResourceRecordUpdate(existing, continued)).not.toThrow();
  for (const mutate of [
    (record: ResourceRecord) => {
      record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: null };
    },
    (record: ResourceRecord) => {
      const intent = record.intents[0];
      if (!intent) return;
      record.intents = [
        {
          ...intent,
          state: "submitted",
          attempts: [
            {
              attemptId: "attempt",
              request: { kind: "create", body: { documentId: "document" } },
            },
          ],
        },
      ];
    },
  ]) {
    const invalid = reserved();
    mutate(invalid);
    expect(() => validateResourceRecordUpdate(null, invalid)).toThrow(
      "may only be reserved with a new local resource",
    );
  }
});

it("does not let reserved content change identity or restart after acknowledgement", () => {
  const first = reserved();
  const changed = structuredClone(first);
  changed.resource.revision = 2;
  changed.resource.identity.documentId = "replacement";
  if (changed.resource.content.kind === "exact") delete changed.resource.content.initialization;
  expect(() => validateResourceRecordUpdate(first, changed)).toThrow(
    "Reserved content identity cannot change",
  );

  const initialized = structuredClone(first);
  if (initialized.resource.content.kind === "exact")
    delete initialized.resource.content.initialization;
  const restarted = structuredClone(initialized);
  restarted.resource.revision = 2;
  if (restarted.resource.content.kind === "exact")
    restarted.resource.content.initialization = "reserved";
  expect(() => validateResourceRecordUpdate(initialized, restarted)).toThrow(
    "reservation cannot restart",
  );
});

{
  function local(): ResourceRecord {
    return {
      resource: {
        handle: "lineage",
        revision: 1,
        identity: { documentId: "document", revision: 1 },
        content: { kind: "exact", databaseName: "original", schema: null },
        classification: { editable: true, filetype: "markdown", schemaType: "document" },
        materialization: { kind: "untitled", folderPath: "", provisionalName: "Untitled" },
        canonical: null,
        lifecycle: { kind: "local" },
        aliases: {},
        obligations: { createEligibility: { eligibleAt: 1 } },
      },
      intents: [
        {
          projectId: "project",
          handle: "lineage",
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

  it("queues cleanup for never-submitted writing and cancels namespace work", () => {
    const before = local();
    const create = before.intents[0];
    if (!create) throw new Error("fixture missing create");
    const write = planResourceDeletion(before, "project", "delete", "operation", undefined, 1000);
    expect(write).not.toBeNull();
    if (!write) throw new Error("missing plan");
    expect(write.expectedRevision).toBe(1);
    expect(write.next.resource).toEqual({
      ...before.resource,
      revision: 2,
      obligations: {
        ...before.resource.obligations,
        cleanup: {
          obligationId: "delete",
          exactDatabaseName: "original",
          notBefore: 1000 + LOCAL_DELETION_UNDO_MS,
        },
      },
    });
    expect(write.next.intents.map(({ state }) => state)).toEqual(["cancelled", "settled-locally"]);
    expect(() => validateResourceRecordUpdate(before, write.next)).not.toThrow();
    // Undo inside the window supersedes the deletion and sends the create again; after it, nothing.
    const undo = planLocalDeletionUndo(write.next, {
      operationId: "operation",
      createIntentId: "again",
      now: 1000 + LOCAL_DELETION_UNDO_MS - 1,
    });
    if (!undo) throw new Error("Undo inside the window was refused");
    expect(() => validateResourceRecordUpdate(write.next, undo.next)).not.toThrow();
    expect(undo.next.intents.map(({ state }) => state)).toEqual([
      "cancelled",
      "superseded",
      "pending",
    ]);
    expect(undo.next.resource.obligations.cleanup).toBeUndefined();
    expect(
      planLocalDeletionUndo(write.next, {
        operationId: "operation",
        createIntentId: "again",
        now: 1000 + LOCAL_DELETION_UNDO_MS,
      }),
    ).toBeNull();
    expect(planResourceDeletion(write.next, "project", "another-delete")).toBeNull();
    const revived = structuredClone(write.next);
    revived.resource.revision++;
    revived.intents = [...revived.intents, { ...create, intentId: "new-create", sequence: 3 }];
    expect(() => validateResourceRecordUpdate(write.next, revived)).toThrow(
      "cannot retain executable namespace work",
    );
    expect(before.intents[0]?.state).toBe("pending");
    const forged = structuredClone(write.next);
    forged.resource.obligations.createEligibility = { eligibleAt: 1 };
    forged.intents = [{ ...create, state: "pending" }, ...forged.intents.slice(1)];
    expect(() => validateResourceRecordUpdate(before, forged)).toThrow("executable namespace work");
  });

  it("preserves submitted create uncertainty rather than pretending deletion canceled its HTTP request", () => {
    const before = local();
    const create = before.intents[0];
    if (!create) throw new Error("fixture missing create");
    before.intents = [
      {
        ...create,
        state: "submitted",
        attempts: [
          {
            attemptId: "attempt",
            request: { kind: "create", body: { documentId: "document" } },
          },
        ],
      },
    ];
    const write = planResourceDeletion(before, "project", "delete");
    if (!write) throw new Error("missing plan");
    expect(write.next.intents[0]).toEqual(before.intents[0]);
    expect(write.next.intents[1]?.state).toBe("pending");
    expect(() => validateResourceRecordUpdate(before, write.next)).not.toThrow();
    const forged = structuredClone(write.next);
    forged.intents = forged.intents.map((intent) =>
      intent.desired.kind === "delete" ? { ...intent, state: "settled-locally" } : intent,
    );
    expect(() => validateResourceRecordUpdate(before, forged)).toThrow("executable namespace work");
  });

  it.each([
    "acknowledged",
  ] as const)("keeps %s deletion pending without a remote outcome", (evidence) => {
    const before = local();
    if (evidence === "acknowledged")
      before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    const write = planResourceDeletion(before, "project", "delete");
    if (!write) throw new Error("missing plan");
    expect(write.next.intents.at(-1)?.state).toBe("pending");
    expect(() => validateResourceRecordUpdate(before, write.next)).not.toThrow();
  });

  it("lets delete supersede a failed location and dispatch next", () => {
    const before = local();
    before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
    before.resource.canonical = {
      scheme: "manuscript",
      path: "/Chapter.md",
      name: "Chapter.md",
      workId: null,
    };
    before.resource.obligations = {};
    const create = before.intents[0];
    if (!create) throw new Error("Expected create");
    before.intents = [
      { ...create, state: "settled" },
      {
        projectId: "project",
        handle: "lineage",
        intentId: "failed-move",
        sequence: 2,
        identityRevision: 1,
        desired: {
          kind: "set-location",
          typedName: "Renamed.md",
          destination: {
            parent: { kind: "root", scheme: "manuscript", owner: { workId: null } },
            name: "Renamed.md",
          },
        },
        attempts: [],
        state: "needs-repair",
      },
    ];

    const deletion = planResourceDeletion(before, "project", "delete");
    if (!deletion) throw new Error("Expected deletion");
    expect(deletion.next.intents.map(({ state }) => state)).toEqual([
      "settled",
      "superseded",
      "pending",
    ]);
    expect(
      prepareNamespaceAttempt(deletion.next, {
        attemptId: "delete",
        operationId: "operation",
      })?.next.intents.at(-1)?.state,
    ).toBe("submitted");
  });
}

it("constructs No Work only from the locked row and requires named Work handles", () => {
  expect(
    resourceWorkAuthorityFor("none", {
      works: [],
      noWork: { id: "none" },
    }),
  ).toEqual({
    workId: "none",
    workHandle: null,
  });
  expect(() =>
    resourceWorkAuthorityFor("named", {
      works: [{ id: "named", handle: null }],
      noWork: { id: "none" },
    }),
  ).toThrow();
  const named = resourceWorkAuthorityFor("named", {
    works: [{ id: "named", handle: "w1" }],
    noWork: { id: "none" },
  });
  expect(resourceContextAuthority("scratch", named)).toEqual({ kind: "work", workHandle: "w1" });
  expect(() => resourceContextAuthority("scratch", { workId: null })).toThrow();
});
