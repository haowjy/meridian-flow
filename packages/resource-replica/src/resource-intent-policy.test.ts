import { expect, it } from "vitest";
import { resourceNeedsBackgroundReconciliation } from "./resource-intent-policy";
import type { NamespaceIntent, ResourceRecord } from "./resource-records";

function record(intent?: Pick<NamespaceIntent, "state" | "desired">): ResourceRecord {
  return {
    resource: {
      handle: "resource",
      revision: 1,
      identity: { documentId: "document", revision: 1 },
      content: { kind: "unacquired" },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: {},
    },
    intents: intent
      ? [
          {
            projectId: "project",
            handle: "resource",
            intentId: "intent",
            sequence: 1,
            identityRevision: 1,
            attempts: [],
            ...intent,
          },
        ]
      : [],
  };
}

it.each([
  "pending",
  "submitted",
  "received",
] as const)("retries unchanged %s namespace uncertainty", (state) => {
  expect(
    resourceNeedsBackgroundReconciliation(
      record({ state, desired: { kind: "create", folderPath: "" } }),
    ),
  ).toBe(true);
});

it("retries create-conflict repair but leaves writer-actionable rename repair idle", () => {
  expect(
    resourceNeedsBackgroundReconciliation(
      record({ state: "needs-repair", desired: { kind: "create", folderPath: "" } }),
    ),
  ).toBe(true);
  expect(
    resourceNeedsBackgroundReconciliation(
      record({
        state: "needs-repair",
        desired: {
          kind: "set-location",
          destination: {
            scheme: "manuscript",
            folderPath: "",
            name: "Taken.md",
            workId: null,
          },
        },
      }),
    ),
  ).toBe(false);
});

it("skips settled resources and retries unfinished adoption or cleanup", () => {
  expect(resourceNeedsBackgroundReconciliation(record())).toBe(false);

  const adoption = record();
  adoption.resource.obligations.sessionAdoption = {
    transitionId: "transition",
    projectId: "project",
    documentId: "document",
    identityRevision: 1,
    exactDatabaseName: "content",
    generation: null,
  };
  expect(resourceNeedsBackgroundReconciliation(adoption)).toBe(true);

  const cleanup = record();
  cleanup.resource.obligations.cleanup = {
    obligationId: "delete",
    exactDatabaseName: "content",
  };
  expect(resourceNeedsBackgroundReconciliation(cleanup)).toBe(true);
});
