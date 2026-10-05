/** No Work link creation uses local admission, not a server acknowledgement. */

import type { CatalogFileEntry } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import {
  planResourceLocation,
  type ResourceRecord,
  reserveResourceDocument,
  validateResourceRecordUpdate,
} from "@meridian/resource-replica";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { expect, it, vi } from "vitest";
import type { CatalogContextView } from "@/client/query/context-catalog-projection";
import {
  accessibleResourceCatalogView,
  projectCatalogFile,
} from "@/client/query/useContextCatalog";
import { ProjectDocumentNavigationAdapter } from "@/features/project/context/open-project-document";
import { useIdentityCommit } from "@/features/project/context/use-identity-commit";
import { resolveLocalDocumentAddress } from "@/features/project/routing/local-document-address";
import { withReactRoot } from "@/test-support/react-dom-harness";
import {
  type CreateLinkedDocument,
  linkCreationTarget,
  useCreateLinkedDocument,
} from "./use-create-linked-document";

const resources = vi.hoisted(() => ({
  reserveDocument: vi.fn(async () => ({
    key: { handle: "resource" },
    content: { kind: "opened", handle: { documentId: "document", release() {} } },
  })),
  setLocation: vi.fn(
    async (
      _project: string,
      _key: { handle: string },
      _destination: import("@meridian/resource-replica").ResourceDestination,
    ) => ({ isLatest: true }),
  ),
  deleteDocument: vi.fn(),
}));
// A server response that never arrives: local creation must not depend on it.
vi.mock("@/client/api/projects-api", () => ({ createContextEntry: () => new Promise(() => {}) }));
vi.mock("@/client/query/useWorks", () => ({
  useWorks: () => ({ works: [], noWork: { id: "123e4567-e89b-42d3-a456-426614174000" } }),
}));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountResourceReplica: () => resources,
}));

it("opens a No Work Scratch Create before the server answers", async () => {
  let creation!: CreateLinkedDocument;
  function Probe() {
    creation = useCreateLinkedDocument("project", null);
    return null;
  }
  const workId = parseRequestId("123e4567-e89b-42d3-a456-426614174000");
  if (!workId) throw new Error("Invalid Work id");
  let record: ResourceRecord;
  resources.reserveDocument.mockImplementation(async () => {
    record = reserveResourceDocument({
      projectId: "project",
      handle: "resource",
      documentId: "document",
      databaseName: "content",
      schema: "schema",
      intentId: "create",
    }).next;
    if (record.resource.content.kind === "exact") delete record.resource.content.initialization;
    return {
      key: { handle: "resource" },
      content: { kind: "opened", handle: { documentId: "document", release() {} } },
    };
  });
  resources.setLocation.mockImplementation(async (_project, _key, destination) => {
    const write = planResourceLocation({
      record,
      projectId: "project",
      intentId: "place",
      eligibleAt: 1,
      destination,
    });
    if (write) {
      validateResourceRecordUpdate(record, write.next);
      record = write.next;
    }
    return { isLatest: true };
  });
  const assertLocalDestination = (documentId: string) => {
    const normalized = accessibleResourceCatalogView(
      "project",
      { kind: "work", projectId: "project", workId: "123e4567-e89b-42d3-a456-426614174000" },
      record,
    );
    const entry = normalized.entries.get(documentId);
    if (entry?.kind !== "file") throw new Error("Missing local file");
    const file = { ...projectCatalogFile(entry), localContent: true as const };
    const catalog = { normalized, findPath: () => file } as unknown as CatalogContextView;
    // The readable destination must admit the local document too, not merely change the URL.
    const result = resolveLocalDocumentAddress(
      "project",
      { kind: "document", scheme: "scratch", path: "notes/scene.md" },
      workId,
      catalog,
    );
    expect(file.uri).toBe("scratch://@/notes/scene.md");
    expect(result?.result).toMatchObject({
      kind: "current",
      document: { documentId: "document", authority: { workSlug: null } },
    });
  };
  const openRoute = vi.fn<
    import("@/features/project/routing/ProjectNavigationContext").OpenContextRoute
  >(async () => ({ kind: "applied" as const }));
  const opener = {
    open: vi.fn(async () => {
      throw new Error("Server must not be needed");
    }),
  };
  const adapter = new ProjectDocumentNavigationAdapter({
    opener,
    openTab: () => {
      throw new Error("Current navigation must use the route owner");
    },
    openRoute,
    resources: {
      accountId: "account",
      openKnownDocument: async () => ({
        kind: "opened" as const,
        key: { handle: "resource" },
        record,
        handle: { release() {} } as never,
      }),
      openDocument: async () => {
        throw new Error("Binding is outside navigation");
      },
    },
  });
  await withReactRoot(
    <QueryClientProvider client={new QueryClient()}>
      <Probe />
    </QueryClientProvider>,
    async () => {
      const target = linkCreationTarget("scratch://@/notes/scene.md");
      if (!target) throw new Error("Missing target");
      await act(async () => {
        void creation.create(target).then((documentId) => {
          if (documentId) return adapter.open("project", { documentId });
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(opener.open).not.toHaveBeenCalled();
      expect(openRoute).toHaveBeenCalledWith(
        { scheme: "scratch", path: "/notes/scene.md", workId: workId, documentId: "document" },
        expect.objectContaining({
          tab: expect.objectContaining({
            documentId: "document",
            name: "scene.md",
            kind: "tracked",
          }),
        }),
      );
      expect(openRoute.mock.calls[0]?.[1]?.tab).not.toHaveProperty("workId");
      assertLocalDestination("document");
      expect(resources.setLocation).toHaveBeenCalledWith(
        "project",
        { handle: "resource" },
        {
          scheme: "scratch",
          folderPath: "notes",
          name: "scene.md",
          workId: "123e4567-e89b-42d3-a456-426614174000",
          workSlug: null,
        },
      );
      expect(creation.failed).toBe(false);
    },
  );
});

it("keeps the locked No Work row in the destination after an Editor identity rename", async () => {
  let rename!: ReturnType<typeof useIdentityCommit>;
  const committed = vi.fn();
  resources.setLocation.mockResolvedValue({ isLatest: true });
  function Probe() {
    rename = useIdentityCommit({
      projectId: "project",
      editorWorkId: null,
      tab: {
        kind: "tracked",
        documentId: "document",
        resourceHandle: "resource",
        scheme: "scratch",
        path: "/before.md",
        name: "before.md",
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
      onCommitted: committed,
    });
    return null;
  }
  await withReactRoot(<Probe />, async () => {
    await act(async () => {
      await rename({ destination: { scheme: "scratch", folderPath: "" }, name: "after.md" });
    });
    expect(committed).toHaveBeenCalledWith(
      "document",
      expect.objectContaining({
        routeWorkId: "123e4567-e89b-42d3-a456-426614174000",
        path: "/after.md",
      }),
      { isLatest: true },
    );
  });
});

it("settles an Uploads background open without admitting an Editor tab", async () => {
  const document: CatalogFileEntry = {
    kind: "file",
    entryId: "upload",
    scope: { kind: "work", projectId: "project", workId: "work" },
    sourceId: "uploads",
    parentId: "uploads",
    name: "map.png",
    aliases: [],
    path: ["map.png"],
    uri: "uploads://@work/map.png",
    provisionalName: false,
    editable: false,
    disposition: "binary",
    fileType: "image",
    mimeType: "image/png",
  };
  const result = { kind: "not-editable" as const, document };
  const openTab = vi.fn(() => ({ kind: "ineligible" as const }));
  const adapter = new ProjectDocumentNavigationAdapter({
    opener: { open: async () => result },
    openTab,
    openRoute: null,
  });

  expect(await adapter.open("project", { documentId: "upload", disposition: "background" })).toBe(
    result,
  );
  expect(openTab).not.toHaveBeenCalled();
});
