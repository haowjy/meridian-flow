/** Recent distinguishes suppressed identity from identity not yet loaded on this device. */
import {
  planFolderDeletion,
  planResourceDeletion,
  type ResourceProjectionSnapshot,
  reserveResourceDocument,
} from "@meridian/resource-replica";
import { expect, it } from "vitest";
import { threadRecentIdentityIndex } from "./thread-recent-identity";

it("hides descendants of pending deletes and restores them after refusal", () => {
  const scope = { kind: "project" as const, projectId: "project" };
  const deletion = planFolderDeletion({
    projectId: "project",
    handle: "folder",
    folderId: "folder",
    source: { scheme: "kb", path: "/A", name: "A", workId: null },
    intentId: "delete",
    operationId: "delete",
  });
  if (!deletion) throw new Error("Missing deletion");
  const snapshot: ResourceProjectionSnapshot = {
    records: [],
    folders: [deletion.next],
    catalogs: [
      {
        projectId: "project",
        scope,
        revision: 1,
        generation: "g",
        appliedRevision: "1",
        observedHeadRevision: "1",
        cursor: "c",
        entries: [
          {
            kind: "source",
            entryId: "source",
            scheme: "kb",
            scope,
            name: "Knowledge",
            uri: "kb://",
          },
          {
            kind: "folder",
            entryId: "folder",
            sourceId: "source",
            parentId: "source",
            scope,
            name: "A",
            path: ["A"],
            uri: "kb://A",
            hasChildren: true,
          },
          {
            kind: "file",
            entryId: "doc",
            sourceId: "source",
            parentId: "folder",
            scope,
            name: "doc.md",
            path: ["A", "doc.md"],
            uri: "kb://A/doc.md",
            editable: true,
            filetype: "markdown",
            schemaType: "document",
            aliases: [],
            provisionalName: false,
          },
        ],
      },
    ],
  };
  expect(threadRecentIdentityIndex("project", snapshot).get("doc")).toBeNull();
  expect(threadRecentIdentityIndex("other", snapshot).has("doc")).toBe(false);
  expect(threadRecentIdentityIndex("project", snapshot).has("unloaded")).toBe(false);
  snapshot.folders[0].intents[0].state = "needs-repair";
  expect(threadRecentIdentityIndex("project", snapshot).get("doc")).toEqual({
    name: "doc.md",
    path: "kb://A/doc.md",
  });
});

it("marks a pending file delete suppressed even without a loaded catalog", () => {
  const record = reserveResourceDocument({
    projectId: "project",
    handle: "doc",
    documentId: "doc",
    databaseName: "content",
    schema: "document",
    intentId: "create",
  }).next;
  record.resource.canonical = { scheme: "kb", path: "/doc.md", name: "doc.md", workId: null };
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  record.intents = [];
  const deletion = planResourceDeletion(record, "project", "delete");
  if (!deletion) throw new Error("Missing deletion");
  const snapshot: ResourceProjectionSnapshot = {
    records: [deletion.next],
    folders: [],
    catalogs: [],
  };
  expect(threadRecentIdentityIndex("project", snapshot).get("doc")).toBeNull();
  expect(threadRecentIdentityIndex("other", snapshot).has("doc")).toBe(false);
  deletion.next.intents[0].state = "needs-repair";
  expect(threadRecentIdentityIndex("project", snapshot).has("doc")).toBe(false);
});
