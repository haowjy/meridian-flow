/** Both Recent surfaces must suppress the same replica identities, before server settlement. */
import { planFolderDeletion, type ResourceProjectionSnapshot } from "@meridian/resource-replica";
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
            importPending: false,
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
