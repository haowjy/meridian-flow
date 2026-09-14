/** Resource projections update ordinary server tabs and carry terminal removal evidence. */
import type { ResourceRecord } from "@meridian/resource-replica";
import { expect, it } from "vitest";
import type { ContextTab } from "@/client/stores";
import { projectResourceTab } from "./context-tab-from-file";

const serverTab: ContextTab = {
  kind: "tracked",
  documentId: "document",
  scheme: "manuscript",
  path: "/Old.md",
  name: "Old.md",
  editable: true,
  filetype: "markdown",
  schemaType: "document",
};

function record(): ResourceRecord {
  return {
    resource: {
      handle: "catalog:document",
      revision: 2,
      identity: { documentId: "document", revision: 1 },
      content: { kind: "unacquired" },
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      canonical: { scheme: "manuscript", path: "/New.md", name: "New.md", workId: null },
      lifecycle: { kind: "acknowledged", availabilityGeneration: "8" },
      aliases: {},
      obligations: {},
    },
    intents: [],
  };
}

it("projects a server-backed rename without claiming a local resource session", () => {
  expect(projectResourceTab("project", serverTab, [record()])).toEqual({
    kind: "projected",
    resourceHandle: "catalog:document",
    tab: { ...serverTab, path: "/New.md", name: "New.md", provisionalName: false },
  });
});

it("reconciles a member whose recorded handle no longer owns its current document identity", () => {
  const staleMember: ContextTab = {
    ...serverTab,
    tabInstanceId: "member",
    resourceHandle: "superseded-resource",
    origin: "local-resource",
  };
  const current = record();
  current.resource.content = {
    kind: "exact",
    databaseName: "current-content",
    schema: "v0.5",
  };

  expect(projectResourceTab("project", staleMember, [current])).toEqual({
    kind: "projected",
    resourceHandle: "catalog:document",
    tab: {
      ...serverTab,
      path: "/New.md",
      name: "New.md",
      provisionalName: false,
      resourceHandle: "catalog:document",
    },
  });
});

it("turns a settled resource delete into generation-bearing terminal evidence", () => {
  const deleted = record();
  deleted.resource.lifecycle = { kind: "terminal", generation: "9", transitionId: "delete" };

  expect(projectResourceTab("project", serverTab, [deleted])).toEqual({
    kind: "terminal",
    documentIds: ["document"],
    generation: "9",
  });
});

it("preserves viewer classification while projecting its namespace", () => {
  const viewer: ContextTab = {
    kind: "viewer",
    documentId: "document",
    scheme: "manuscript",
    path: "/Old.png",
    name: "Old.png",
    editable: false,
    fileType: "image",
    mimeType: "image/png",
  };
  const image = record();
  image.resource.canonical = {
    scheme: "kb",
    path: "/New.png",
    name: "New.png",
    workId: null,
  };

  expect(projectResourceTab("project", viewer, [image])).toMatchObject({
    kind: "projected",
    tab: {
      kind: "viewer",
      scheme: "kb",
      path: "/New.png",
      fileType: "image",
      mimeType: "image/png",
    },
  });
});
