/** Recent distinguishes suppressed identity from identity not yet loaded on this device. */
import {
  planFolderDeletion,
  planResourceDeletion,
  type ResourceProjectionSnapshot,
  reserveResourceDocument,
} from "@meridian/resource-replica";
import { expect, it } from "vitest";
import { recentDocumentIdentityIndex } from "@/client/query/recent-document-identity";

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
    folders: [
      deletion.next,
      {
        projectId: "project",
        handle: "folder:A",
        folderId: "A",
        revision: 1,
        canonical: { scheme: "kb", path: "/P/A", name: "A", workId: null },
        canonicalParent: { kind: "folder", folderId: "P" },
        intents: [],
      },
    ],
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
            observationVersion: "1",
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
            observationVersion: "1",
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
            importPending: false,
            provisionalName: false,
          },
        ],
      },
    ],
  };
  expect(recentDocumentIdentityIndex("project", snapshot).get("doc")).toBeNull();
  expect(recentDocumentIdentityIndex("other", snapshot).has("doc")).toBe(false);
  expect(recentDocumentIdentityIndex("project", snapshot).has("unloaded")).toBe(false);
  const restored = structuredClone(snapshot);
  restored.folders[0].intents[0].state = "needs-repair";
  expect(recentDocumentIdentityIndex("project", restored).get("doc")).toEqual({
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
  expect(recentDocumentIdentityIndex("project", snapshot).get("doc")).toBeNull();
  expect(recentDocumentIdentityIndex("other", snapshot).has("doc")).toBe(false);
  const restored = structuredClone(snapshot);
  restored.records[0].intents[0].state = "needs-repair";
  expect(recentDocumentIdentityIndex("project", restored).has("doc")).toBe(false);
});

it.each([
  false,
  true,
])("suppresses a known descendant missing its catalog row (checkpoint=%s)", (checkpoint) => {
  const record = reserveResourceDocument({
    projectId: "project",
    handle: "doc",
    documentId: "doc",
    databaseName: "content",
    schema: "document",
    intentId: "create",
  }).next;
  record.resource.canonical = { scheme: "kb", path: "/P/A/doc.md", name: "doc.md", workId: null };
  record.resource.canonicalParent = { kind: "folder", folderId: "A" };
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: "1" };
  record.intents = [];
  const deletion = planFolderDeletion({
    projectId: "project",
    handle: "P",
    folderId: "P",
    source: { scheme: "kb", path: "/P", name: "P", workId: null },
    intentId: "delete",
    operationId: "delete",
  });
  if (!deletion) throw new Error("Missing deletion");
  const scope = { kind: "project" as const, projectId: "project" };
  const snapshot: ResourceProjectionSnapshot = {
    records: [record],
    folders: [
      deletion.next,
      {
        projectId: "project",
        handle: "folder:A",
        folderId: "A",
        revision: 1,
        canonical: { scheme: "kb", path: "/P/A", name: "A", workId: null },
        canonicalParent: { kind: "folder", folderId: "P" },
        intents: [],
      },
    ],
    catalogs: checkpoint
      ? [
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
            ],
          },
        ]
      : [],
  };
  expect(recentDocumentIdentityIndex("project", snapshot).get("doc")).toBeNull();
  expect(recentDocumentIdentityIndex("project", snapshot).has("unknown")).toBe(false);
});
