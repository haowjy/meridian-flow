import { expect, it } from "vitest";
import { prepareNamespaceAttempt, recordNamespaceOutcome } from "./resource-namespace";
import {
  projectResourceLocation,
  resourceForDocumentIdentity,
  resourceVisibleInProject,
} from "./resource-projection";
import type { ResourceCatalogCheckpoint } from "./resource-records";
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
  // Lowest-level contract: naming remains complete after placement ownership retires.
  const settled = placed.next;
  settled.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  settled.intents = settled.intents.map((intent) =>
    intent.desired.kind === "create" ? { ...intent, state: "settled" } : intent,
  );
  const submitted = prepareNamespaceAttempt(settled, { attemptId: "file", operationId: "file" });
  if (!submitted) throw new Error("Missing placement attempt");
  const received = recordNamespaceOutcome(submitted.next, "place", "file", {
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
  // Model the post-refresh state: the historical intent no longer owns placement.
  const intent = received.next.intents.find((intent) => intent.desired.kind === "set-location");
  if (!intent) throw new Error("Missing settled placement");
  intent.state = "settled";
  received.next.resource.canonical = {
    scheme: "manuscript",
    path: "/moved/opening.md",
    name: "opening.md",
    workId: null,
  };
  expect(projectResourceLocation("project-a", received.next)).toMatchObject({
    path: "/moved/opening.md",
    provisional: false,
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

it("shows a document in a project only through that project's own catalogs or intents", () => {
  // Reserved by another project, so only catalogs decide visibility in project-a.
  const record = reserveResourceDocument({
    projectId: "project-x",
    handle: "resource",
    documentId: "document",
    databaseName: "content",
    schema: "schema",
    intentId: "create",
    provisionalName: "Untitled",
  }).next;
  const checkpoint = (
    projectId: string,
    invalidatedEntryIds: readonly string[] = [],
  ): ResourceCatalogCheckpoint =>
    ({
      projectId,
      entries: [{ kind: "file", entryId: "document" }],
      invalidatedEntryIds,
    }) as unknown as ResourceCatalogCheckpoint;

  expect(resourceVisibleInProject("project-a", record, [checkpoint("project-a")])).toBe(true);
  expect(resourceVisibleInProject("project-a", record, [checkpoint("project-b")])).toBe(false);
  expect(
    resourceVisibleInProject("project-a", record, [checkpoint("project-a", ["document"])]),
  ).toBe(false);
  // Invalidation is per catalog: another catalog of the same project still lists it.
  const catalogs = [checkpoint("project-a", ["document"]), checkpoint("project-a")];
  expect(resourceVisibleInProject("project-a", record, catalogs)).toBe(true);
  expect(resourceVisibleInProject("project-b", record, catalogs)).toBe(false);
  expect(resourceVisibleInProject("project-x", record, [])).toBe(true);
});
