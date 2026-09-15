import { expect, it } from "vitest";
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
