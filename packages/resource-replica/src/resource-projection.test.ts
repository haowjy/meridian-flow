import { expect, it } from "vitest";
import {
  installCanonicalRefresh,
  prepareNamespaceAttempt,
  recordNamespaceOutcome,
  settleNamespaceOutcome,
} from "./resource-namespace";
import { projectResourceLocation, resourceForDocumentIdentity } from "./resource-projection";
import { planResourceLocation, reserveResourceDocument } from "./resource-state";

it("projects only the requesting project's durable location intention", () => {
  const record = reserveResourceDocument({
    projectId: "project-a",
    handle: "resource",
    documentId: "document",
    databaseName: "content",
    schema: "schema",
    intentId: "create",
    provisionalName: "Untitled",
  }).next;
  record.resource.canonical = {
    scheme: "user",
    path: "/shared.md",
    name: "shared.md",
    workId: null,
  };
  const placed = planResourceLocation({
    record,
    projectId: "project-a",
    intentId: "place",
    eligibleAt: 1,
    destination: {
      scheme: "manuscript",
      folderPath: "chapters",
      name: "opening.md",
      workId: null,
    },
  });
  if (!placed) throw new Error("Expected placement");

  expect(projectResourceLocation("project-a", placed.next)).toMatchObject({
    scheme: "manuscript",
    path: "/chapters/opening.md",
    provisional: false,
  });
  expect(projectResourceLocation("project-b", placed.next)).toMatchObject({
    scheme: "user",
    path: "/shared.md",
  });
  // Retiring placement ownership must not erase the writer's completed naming command.
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
  record.resource.obligations = {};
  record.intents = placed.next.intents.map((intent) =>
    intent.desired.kind === "create"
      ? {
          ...intent,
          state: "settled",
          attempts: [
            {
              attemptId: "create",
              request: { kind: "create", body: { documentId: "document" } },
              outcome: {
                kind: "create",
                result: {
                  status: "created",
                  documentId: "document",
                  scheme: "user",
                  path: "/shared.md",
                  name: "shared.md",
                },
              },
            },
          ],
        }
      : intent,
  );
  const prepared = prepareNamespaceAttempt(record, { attemptId: "file", operationId: "file" });
  if (!prepared) throw new Error("Missing filing attempt");
  const received = recordNamespaceOutcome(prepared.next, "place", "file", {
    kind: "operation",
    receipt: {
      operationId: "file",
      command: {
        kind: "move",
        sourceUri: "user://shared.md",
        destinationUri: "manuscript://chapters/opening.md",
        expected: { kind: "file", nodeId: "document" },
      },
      result: { ok: true, value: { destinationPath: "chapters/opening.md" } },
    },
  });
  if (!received) throw new Error("Missing filing outcome");
  const settled = settleNamespaceOutcome(received.next, 100);
  if (!settled) throw new Error("Missing filing settlement");
  const refreshed = installCanonicalRefresh({
    record: settled.next,
    operationId: "file",
    location: {
      scheme: "manuscript",
      path: "/chapters/opening.md",
      name: "opening.md",
      workId: null,
    },
  });
  if (!refreshed) throw new Error("Missing filing refresh");
  expect(projectResourceLocation("project-a", refreshed.next)?.provisional).toBe(false);
  if (!refreshed.next.resource.canonical) throw new Error("Missing canonical location");
  refreshed.next.resource.canonical = {
    ...refreshed.next.resource.canonical,
    path: "/moved/opening.md",
  };
  expect(projectResourceLocation("project-a", refreshed.next)).toMatchObject({
    path: "/moved/opening.md",
    provisional: false,
  });
});

it("keeps an acknowledged local create provisional until the writer chooses a home", () => {
  const record = reserveResourceDocument({
    projectId: "project-a",
    handle: "resource",
    documentId: "document",
    databaseName: "content",
    schema: "schema",
    intentId: "create",
    provisionalName: "Untitled",
  }).next;
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  record.resource.canonical = {
    scheme: "unfiled",
    path: "/Untitled.md",
    name: "Untitled.md",
    workId: null,
  };

  expect(projectResourceLocation("project-a", record)).toMatchObject({
    path: "/Untitled.md",
    provisional: true,
  });
});

it("prefers a current server identity over another resource's obsolete remint alias", () => {
  const local = reserveResourceDocument({
    projectId: "project-a",
    handle: "local-resource",
    documentId: "reminted-document",
    databaseName: "content",
    schema: "schema",
    intentId: "create",
  }).next;
  local.resource.aliases["conflicting-document"] = {
    introducedAtIdentityRevision: 2,
  };
  const server = reserveResourceDocument({
    projectId: "project-a",
    handle: "server-resource",
    documentId: "conflicting-document",
    databaseName: "server-content",
    schema: "schema",
    intentId: "server",
  }).next;

  expect(
    resourceForDocumentIdentity([local, server], "conflicting-document")?.resource.handle,
  ).toBe("server-resource");
  expect(resourceForDocumentIdentity([local], "conflicting-document")?.resource.handle).toBe(
    "local-resource",
  );
});
