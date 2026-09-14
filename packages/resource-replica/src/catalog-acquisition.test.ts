/** Catalog acquisition owns request ordering while metadata CAS owns cross-context races. */
import type { CatalogChanges, CatalogScope, CatalogSnapshot } from "@meridian/contracts/protocol";
import { expect, it, vi } from "vitest";
import { ResourceCatalogAcquisition, type ResourceCatalogTransport } from "./catalog-acquisition";
import type {
  ProjectResourceSnapshot,
  ResourceCatalogCheckpoint,
  ResourceMetadataStore,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";

const projectId = "project";
const scope = { kind: "project", projectId } as const satisfies CatalogScope;

function snapshot(path = "chapter.md", revision = "1"): CatalogSnapshot {
  return {
    scope,
    generation: "generation",
    headRevision: revision,
    cursor: `cursor-${revision}`,
    entries: [
      {
        kind: "source",
        entryId: "source",
        scope,
        scheme: "manuscript",
        name: "Manuscript",
        uri: "manuscript://",
      },
      {
        kind: "file",
        entryId: "document",
        scope,
        sourceId: "source",
        parentId: "source",
        name: path,
        aliases: [],
        path: [path],
        uri: `manuscript://${path}`,
        provisionalName: false,
        editable: true,
        filetype: "markdown",
        schemaType: "document",
      },
    ],
  };
}

function resource(path: string, revision: number, refresh = false): ResourceRecord {
  return {
    resource: {
      handle: "resource",
      revision,
      identity: { documentId: "document", revision: 1 },
      content: { kind: "exact", databaseName: "exact", schema: "0.5" },
      canonical: { scheme: "manuscript", path: `/${path}`, name: path, workId: null },
      lifecycle: { kind: "acknowledged", availabilityGeneration: "generation" },
      aliases: {},
      obligations: refresh
        ? { canonicalRefresh: { operationId: "move", identityRevision: 1 } }
        : {},
    },
    intents: [],
  };
}

function catalogKey(project: string, catalogScope: CatalogScope): string {
  return JSON.stringify([project, catalogScope.kind]);
}

class MemoryMetadata implements ResourceMetadataStore {
  readonly accountId = "account";
  readonly records = new Map<string, ResourceRecord>();
  readonly catalogs = new Map<string, ResourceCatalogCheckpoint>();
  catalogCommits = 0;

  async readResource(key: { handle: string }) {
    return structuredClone(this.records.get(key.handle) ?? null);
  }

  async readProject(project: string): Promise<ProjectResourceSnapshot> {
    return structuredClone({
      records: [...this.records.values()],
      catalogs: [...this.catalogs.values()].filter((catalog) => catalog.projectId === project),
    });
  }

  async commitResource(write: ResourceWrite) {
    const current = this.records.get(write.next.resource.handle);
    if ((current?.resource.revision ?? null) !== write.expectedRevision) return "stale" as const;
    this.records.set(write.next.resource.handle, structuredClone(write.next));
    return "committed" as const;
  }

  async readCatalog(project: string, catalogScope: CatalogScope) {
    return structuredClone(this.catalogs.get(catalogKey(project, catalogScope)) ?? null);
  }

  async commitCatalog(input: {
    expectedRevision: number | null;
    next: ResourceCatalogCheckpoint;
    resources: readonly ResourceWrite[];
  }) {
    const key = catalogKey(input.next.projectId, input.next.scope);
    const current = this.catalogs.get(key);
    if ((current?.revision ?? null) !== input.expectedRevision) return "stale" as const;
    for (const write of input.resources) {
      const record = this.records.get(write.next.resource.handle);
      if ((record?.resource.revision ?? null) !== write.expectedRevision) return "stale" as const;
    }
    for (const write of input.resources)
      this.records.set(write.next.resource.handle, structuredClone(write.next));
    this.catalogs.set(key, structuredClone(input.next));
    this.catalogCommits += 1;
    return "committed" as const;
  }

  observeProject() {
    return () => undefined;
  }
  beginClose() {}
  async finishClose() {}
}

function transport(overrides: Partial<ResourceCatalogTransport> = {}): ResourceCatalogTransport {
  return {
    accountId: "account",
    snapshot: vi.fn(async () => snapshot()),
    changes: vi.fn(
      async (_project, _scope, cursor): Promise<CatalogChanges> => ({
        kind: "delta",
        scope,
        commits: [],
        nextCursor: cursor,
        headRevision: "1",
        hasMore: false,
      }),
    ),
    ...overrides,
  };
}

it("installs a discovered resource once and avoids identical polling churn", async () => {
  const metadata = new MemoryMetadata();
  const catalogTransport = transport();
  const acquisition = new ResourceCatalogAcquisition("account", metadata, catalogTransport);

  await expect(acquisition.acquire(projectId, scope)).resolves.toMatchObject({
    cursor: "cursor-1",
  });
  expect(metadata.records.get("catalog:document")?.resource).toMatchObject({
    content: { kind: "unacquired" },
    canonical: { path: "/chapter.md" },
  });
  expect(metadata.catalogCommits).toBe(1);

  await acquisition.acquire(projectId, scope);
  expect(catalogTransport.changes).toHaveBeenCalledTimes(1);
  expect(metadata.catalogCommits).toBe(1);
});

it("reuses a captured response after resource CAS loss without regressing newer canonical truth", async () => {
  const metadata = new MemoryMetadata();
  metadata.records.set("resource", resource("before.md", 1, true));
  let resolveSnapshot: (value: CatalogSnapshot) => void = () => undefined;
  const response = new Promise<CatalogSnapshot>((resolve) => {
    resolveSnapshot = resolve;
  });
  const catalogTransport = transport({ snapshot: vi.fn(() => response) });
  const acquisition = new ResourceCatalogAcquisition("account", metadata, catalogTransport);

  const pending = acquisition.acquire(projectId, scope);
  await vi.waitFor(() => expect(catalogTransport.snapshot).toHaveBeenCalledTimes(1));
  metadata.records.set("resource", resource("newer.md", 2));
  resolveSnapshot(snapshot("stale.md"));
  await pending;

  expect(metadata.records.get("resource")?.resource.canonical?.path).toBe("/newer.md");
  expect(catalogTransport.snapshot).toHaveBeenCalledTimes(1);
  expect(metadata.catalogCommits).toBe(1);
});
