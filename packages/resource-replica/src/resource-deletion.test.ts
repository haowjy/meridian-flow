/** Local deletion retains content and never converts uncertain HTTP work into fake settlement. */
import { expect, it } from "vitest";
import { planResourceDeletion } from "./resource-deletion";
import type { ResourceRecord } from "./resource-records";
import { validateResourceRecordUpdate } from "./resource-records-policy";

function local(): ResourceRecord {
  return {
    resource: {
      projectId: "project",
      handle: "lineage",
      revision: 1,
      identity: { documentId: "document", revision: 1 },
      content: { kind: "exact", databaseName: "original", schema: null },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: {},
    },
    intents: [
      {
        projectId: "project",
        handle: "lineage",
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

it("retains never-submitted writing with a local deletion fence and cancelled namespace work", () => {
  const before = local();
  const create = before.intents[0];
  if (!create) throw new Error("fixture missing create");
  const write = planResourceDeletion(before, "delete");
  expect(write).not.toBeNull();
  if (!write) throw new Error("missing plan");
  expect(write.expectedRevision).toBe(1);
  expect(write.next.resource).toEqual({ ...before.resource, revision: 2 });
  expect(write.next.intents.map(({ state }) => state)).toEqual(["cancelled", "settled-locally"]);
  expect(() => validateResourceRecordUpdate(before, write.next)).not.toThrow();
  expect(planResourceDeletion(write.next, "another-delete")).toBeNull();
  const revived = structuredClone(write.next);
  revived.resource.revision++;
  revived.intents = [...revived.intents, { ...create, intentId: "new-create", sequence: 3 }];
  expect(() => validateResourceRecordUpdate(write.next, revived)).toThrow(
    "cannot retain executable namespace work",
  );
  expect(before.intents[0]?.state).toBe("pending");
  const forged = structuredClone(write.next);
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
  const write = planResourceDeletion(before, "delete");
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
  "recovery",
  "acknowledged",
  "canonical",
] as const)("keeps %s deletion pending without a remote outcome", (evidence) => {
  const before = local();
  if (evidence === "recovery") before.resource.recovery = { sourceKey: "legacy" };
  if (evidence === "acknowledged")
    before.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  if (evidence === "canonical")
    before.resource.canonical = {
      scheme: "unfiled",
      path: "Untitled.md",
      name: "Untitled.md",
      workId: null,
    };
  const write = planResourceDeletion(before, "delete");
  if (!write) throw new Error("missing plan");
  expect(write.next.intents.at(-1)?.state).toBe("pending");
  expect(() => validateResourceRecordUpdate(before, write.next)).not.toThrow();
});
