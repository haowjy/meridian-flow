/** Resource-record state transitions protect the one-shot local content reservation. */
import { expect, it } from "vitest";
import type { ResourceRecord } from "./resource-records";
import { validateResourceRecordUpdate } from "./resource-records-policy";

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
        desired: { kind: "create", folderPath: "" },
        attempts: [],
        state: "pending",
      },
    ],
  };
}

it("allows a new local reservation and its one-way initialization acknowledgement", () => {
  const first = reserved();
  expect(() => validateResourceRecordUpdate(null, first)).not.toThrow();
  const initialized = structuredClone(first);
  initialized.resource.revision = 2;
  if (initialized.resource.content.kind === "exact")
    delete initialized.resource.content.initialization;
  expect(() => validateResourceRecordUpdate(first, initialized)).not.toThrow();
});

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
