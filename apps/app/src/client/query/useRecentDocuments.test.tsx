/** Both Recent surfaces must suppress the same replica identities, before server settlement. */
import {
  planFolderDeletion,
  planResourceDeletion,
  type ResourceProjectionSnapshot,
  reserveResourceDocument,
} from "@meridian/resource-replica";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { bindAccountRecents, touchAccountRecent } from "@/client/recents";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { accountQueryKeys } from "./account-query-keys";
import { recentDocumentIdentityIndex } from "./recent-document-identity";
import { useRecentDocuments } from "./useRecentDocuments";

const observation = vi.hoisted(() => ({ snapshot: null as ResourceProjectionSnapshot | null }));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountResourceProjection: () => ({ snapshot: observation.snapshot }),
}));
vi.mock("@/client/api/recent-documents-api", () => ({ listRecentDocuments: async () => [] }));

it("hides a pending folder descendant, restores refusal, and refetches after accepted deletion", async () => {
  const scope = { kind: "project" as const, projectId: "recent-test" };
  const deletion = planFolderDeletion({
    projectId: scope.projectId,
    handle: "folder",
    folderId: "folder",
    source: { scheme: "kb", path: "/A", name: "A", workId: null },
    intentId: "delete",
    operationId: "delete",
  });
  if (!deletion) throw new Error("Missing deletion");
  observation.snapshot = {
    records: [],
    folders: [deletion.next],
    catalogs: [
      {
        projectId: scope.projectId,
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
            hasProperties: false,
            provisionalName: false,
          },
        ],
      },
    ],
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let redraw = () => {};
  let documents: ReturnType<typeof useRecentDocuments>["documents"] = [];
  function Child() {
    const [, setVersion] = useState(0);
    redraw = () => setVersion((n) => n + 1);
    documents = useRecentDocuments(scope.projectId).documents;
    return null;
  }
  await withReactRoot(
    <QueryClientProvider client={client}>
      <Child />
    </QueryClientProvider>,
    async () => {
      await act(async () => {
        bindAccountRecents("recent-account");
        touchAccountRecent("recent-account", {
          projectId: scope.projectId,
          documentId: "doc",
          name: "doc.md",
          openedAt: new Date().toISOString(),
          address: { kind: "document", scheme: "kb", path: "/A/doc.md" },
        });
      });
      expect(
        recentDocumentIdentityIndex(scope.projectId, observation.snapshot).get("doc"),
      ).toBeNull();
      expect(documents).toEqual([]);
      const restored = structuredClone(observation.snapshot);
      if (!restored) throw new Error("Missing snapshot");
      restored.folders[0].intents[0].state = "needs-repair";
      await act(async () => {
        observation.snapshot = restored;
        redraw();
      });
      expect(documents.map((row) => row.documentId)).toEqual(["doc"]);
      const invalidate = vi.spyOn(client, "invalidateQueries");
      const accepted = structuredClone(restored);
      accepted.folders[0].intents[0].state = "settled";
      await act(async () => {
        observation.snapshot = accepted;
        redraw();
      });
      expect(documents).toEqual([]);
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: accountQueryKeys.recentDocuments("recent-account", scope.projectId),
      });
    },
    { drainMacrotask: true },
  );
  client.clear();
});

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
        serverHold: "held",
        observationVersion: "0",
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
            provisionalName: false,
          },
        ],
      },
    ],
  };
  expect(recentDocumentIdentityIndex("project", snapshot).get("doc")).toBeNull();
  expect(recentDocumentIdentityIndex("other", snapshot).get("doc")).toBeUndefined();
  expect(recentDocumentIdentityIndex("project", snapshot).get("unloaded")).toBeUndefined();
  const restored = structuredClone(snapshot);
  restored.folders[0].intents[0].state = "needs-repair";
  expect(recentDocumentIdentityIndex("project", restored).get("doc")).toEqual({
    documentId: "doc",
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
  record.resource.serverHold = "held";
  record.intents = [];
  const deletion = planResourceDeletion(record, "project", "delete");
  if (!deletion) throw new Error("Missing deletion");
  // A joined document's old id answers with its resource's suppression too.
  deletion.next.resource.aliases = { "old-doc": { introducedAtIdentityRevision: 2 } };
  const snapshot: ResourceProjectionSnapshot = {
    records: [deletion.next],
    folders: [],
    catalogs: [],
  };
  expect(recentDocumentIdentityIndex("project", snapshot).get("doc")).toBeNull();
  expect(recentDocumentIdentityIndex("project", snapshot).get("old-doc")).toBeNull();
  expect(recentDocumentIdentityIndex("other", snapshot).get("doc")).toBeUndefined();
  const restored = structuredClone(snapshot);
  restored.records[0].intents[0].state = "needs-repair";
  expect(recentDocumentIdentityIndex("project", restored).get("doc")).toBeUndefined();
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
  record.resource.serverHold = "held";
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
        serverHold: "held",
        observationVersion: "0",
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
  expect(recentDocumentIdentityIndex("project", snapshot).get("unknown")).toBeUndefined();
});
