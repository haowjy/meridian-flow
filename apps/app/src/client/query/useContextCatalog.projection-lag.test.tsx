// @vitest-environment jsdom
/** A completed catalog request remains visible while its IndexedDB projection catches up. */
import { catalogViewFromSnapshot, reserveResourceDocument } from "@meridian/resource-replica";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState } from "react";
import { expect, it, vi } from "vitest";
import { withReactRoot } from "@/test-support/react-dom-harness";

const serverView = catalogViewFromSnapshot({
  scope: { kind: "project", projectId: "project" },
  generation: "server-generation",
  headRevision: "1",
  cursor: "cursor",
  entries: [
    {
      kind: "source",
      entryId: "manuscript-source",
      scope: { kind: "project", projectId: "project" },
      scheme: "manuscript",
      name: "Manuscript",
      uri: "manuscript://",
    },
    {
      kind: "file",
      entryId: "server-document",
      scope: { kind: "project", projectId: "project" },
      sourceId: "manuscript-source",
      parentId: "manuscript-source",
      name: "Chapter.md",
      aliases: [],
      path: ["Chapter.md"],
      uri: "manuscript://Chapter.md",
      provisionalName: false,
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
  ],
});
const unrelated = reserveResourceDocument({
  projectId: "project",
  handle: "local-resource",
  documentId: "local-document",
  databaseName: "local-content",
  schema: "schema",
  intentId: "local-create",
}).next;
const resources = { acquireCatalog: vi.fn(async () => serverView) };
const projection = {
  records: [unrelated],
  snapshot: null,
  error: null,
};

vi.mock("@/features/project/context/account-feature-context", () => ({
  useAccountResourceReplica: () => resources,
  useAccountResourceProjection: () => projection,
}));
const { useContextCatalogView } = await import("./useContextCatalog");

it("uses the acquired query result before the durable projection emits its checkpoint", async () => {
  let observed: { complete: boolean; name: string | null } | null = null;
  function Probe() {
    const { catalog, isComplete } = useContextCatalogView("project", "manuscript", {
      workId: null,
    });
    observed = {
      complete: isComplete,
      name: catalog?.findDocument("server-document")?.name ?? null,
    };
    return null;
  }

  await withReactRoot(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Probe />
    </QueryClientProvider>,
    async () => {
      await vi.waitFor(() => expect(observed).toEqual({ complete: false, name: "Chapter.md" }));
    },
  );
});

it("retains the catalog projection across an unrelated component rerender", async () => {
  let rerender: () => void = () => undefined;
  let catalog: ReturnType<typeof useContextCatalogView>["catalog"] = null;
  function Probe() {
    const [, setRevision] = useState(0);
    rerender = () => setRevision((value) => value + 1);
    catalog = useContextCatalogView("project", "manuscript", { workId: null }).catalog;
    return null;
  }

  await withReactRoot(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Probe />
    </QueryClientProvider>,
    async () => {
      await vi.waitFor(() => expect(catalog?.findDocument("server-document")).not.toBeNull());
      const first = catalog;
      await act(async () => rerender());
      expect(catalog).toBe(first);
    },
  );
});
