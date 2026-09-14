// @vitest-environment jsdom
/** A completed catalog request remains visible while its IndexedDB projection catches up. */
import type { CatalogScope } from "@meridian/contracts/protocol";
import type { CatalogCacheView, ResourceProjectionSnapshot } from "@meridian/resource-replica";
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
const resources = {
  acquireCatalog: vi.fn(async (_projectId: string, _scope: CatalogScope) => serverView),
};
const projection = {
  records: [unrelated],
  snapshot: null as ResourceProjectionSnapshot | null,
  error: null,
};

vi.mock("@/features/project/context/account-feature-context", () => ({
  useOptionalAccountResourceReplica: () => resources,
  useAccountResourceProjection: () => projection,
}));
const { useContextCatalogView, useContextCatalogViews } = await import("./useContextCatalog");

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

it("shares one query observer per authority scope across scheme views", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const schemes = ["manuscript", "kb", "unfiled", "user", "scratch", "uploads"] as const;
  let observed: ReturnType<typeof useContextCatalogViews<(typeof schemes)[number]>> | undefined;
  function Probe() {
    observed = useContextCatalogViews("project", schemes, { workId: null });
    return null;
  }
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
      async () => {
        await vi.waitFor(() =>
          expect(observed?.manuscript.catalog?.findDocument("server-document")?.name).toBe(
            "Chapter.md",
          ),
        );
        expect(
          client
            .getQueryCache()
            .getAll()
            .map((query) => query.getObserversCount()),
        ).toEqual([1, 1, 1]);
        expect(observed?.unfiled.catalog?.findDocument("local-document")).toMatchObject({
          resourceHandle: "local-resource",
        });
        expect(observed?.unfiled.isComplete).toBe(false);
      },
    );
  } finally {
    client.clear();
  }
});

it("reuses fresh scope acquisitions when a retained editor becomes active again", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const schemes = ["manuscript", "kb", "unfiled", "user", "scratch", "uploads"] as const;
  let activate = (_active: boolean) => {};
  let ready = false;
  function Probe() {
    const [active, setActive] = useState(true);
    activate = setActive;
    const views = useContextCatalogViews(active ? "project" : "", schemes, {
      workId: null,
      enabled: active,
    });
    ready =
      !views.manuscript.isFetching &&
      Boolean(views.manuscript.catalog?.findDocument("server-document"));
    return null;
  }
  const before = resources.acquireCatalog.mock.calls.length;
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
      async () => {
        await vi.waitFor(() => expect(ready).toBe(true));
        expect(resources.acquireCatalog.mock.calls.length - before).toBe(3);
        await act(async () => activate(false));
        await act(async () => activate(true));
        await vi.waitFor(() => expect(ready).toBe(true));
        expect(resources.acquireCatalog.mock.calls.length - before).toBe(3);
      },
    );
  } finally {
    client.clear();
  }
});

it("isolates rows, completeness and retry across No Work and Work transitions", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pending = new Map<
    string,
    { resolve(view: CatalogCacheView): void; reject(error: Error): void }
  >();
  const scratch = (workId: string | null) => {
    const scope: CatalogScope = workId
      ? { kind: "work", projectId: "project", workId }
      : { kind: "none", projectId: "project" };
    const id = workId ?? "shared";
    return catalogViewFromSnapshot({
      scope,
      generation: "generation",
      headRevision: "1",
      cursor: id,
      entries: [
        {
          kind: "source",
          entryId: `source-${id}`,
          scope,
          scheme: "scratch",
          name: "Scratch",
          uri: "scratch://",
        },
        {
          kind: "file",
          entryId: id,
          sourceId: `source-${id}`,
          parentId: `source-${id}`,
          scope,
          name: `${id}.md`,
          path: [`${id}.md`],
          uri: `scratch://${id}.md`,
          aliases: [],
          provisionalName: false,
          editable: true,
          filetype: "markdown",
          schemaType: "document",
        },
      ],
    });
  };
  const install = (view: CatalogCacheView) => {
    projection.snapshot = {
      records: [unrelated],
      catalogs: [
        {
          projectId: "project",
          revision: 1,
          scope: view.scope,
          generation: view.generation,
          appliedRevision: view.appliedRevision,
          observedHeadRevision: view.observedHeadRevision,
          cursor: view.cursor,
          entries: [...view.entries.values()],
          invalidatedEntryIds: [],
        },
      ],
    };
  };
  const shared = scratch(null);
  install(shared);
  resources.acquireCatalog.mockImplementation(async (_projectId, scope) => {
    if (scope.kind !== "work") return shared;
    return new Promise<CatalogCacheView>((resolve, reject) =>
      pending.set(scope.workId, { resolve, reject }),
    );
  });
  let changeWork = (_workId: string | null) => {};
  let current: ReturnType<typeof useContextCatalogView> | undefined;
  function Probe() {
    const [selection, setSelection] = useState({ workId: null as string | null, revision: 0 });
    changeWork = (workId) => setSelection(({ revision }) => ({ workId, revision: revision + 1 }));
    current = useContextCatalogView("project", "scratch", { workId: selection.workId });
    return null;
  }
  const names = () => current?.catalog?.files().map((file) => file.name) ?? [];
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
      async () => {
        expect(names()).toEqual(["shared.md"]);
        expect(current?.isComplete).toBe(true);
        await act(async () => changeWork("work-a"));
        expect(names()).toEqual([]);
        expect(current?.isComplete).toBe(false);
        await act(async () => pending.get("work-a")?.reject(new Error("Work A unavailable")));
        await vi.waitFor(() => expect(current?.isError).toBe(true));
        pending.delete("work-a");
        await act(async () => {
          current?.refetch();
        });
        expect(pending.has("work-a")).toBe(true);
        await act(async () => changeWork("work-b"));
        expect(names()).toEqual([]);
        expect(current?.isError).toBe(false);
        await act(async () => pending.get("work-a")?.resolve(scratch("work-a")));
        expect(names()).toEqual([]);
        await act(async () => pending.get("work-b")?.resolve(scratch("work-b")));
        await vi.waitFor(() => expect(names()).toEqual(["work-b.md"]));
        expect(current?.isComplete).toBe(false);
        install(scratch("work-b"));
        await act(async () => changeWork("work-b"));
        expect(current?.isComplete).toBe(true);
      },
    );
  } finally {
    projection.snapshot = null;
    resources.acquireCatalog.mockImplementation(async () => serverView);
    client.clear();
  }
});
