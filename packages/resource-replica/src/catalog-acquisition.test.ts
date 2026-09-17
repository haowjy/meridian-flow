/** Catalog acquisition owns request ordering while metadata CAS owns cross-context races. */
import type { CatalogChanges, CatalogScope, CatalogSnapshot } from "@meridian/contracts/protocol";
import { expect, it, vi } from "vitest";
import { ResourceCatalogAcquisition, type ResourceCatalogTransport } from "./catalog-acquisition";
import { catalogProjectionKey } from "./catalog-scope";
import type {
  ResourceCatalogCheckpoint,
  ResourceMetadataStore,
  ResourceProjectionSnapshot,
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
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
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
  return catalogProjectionKey(project, catalogScope);
}

class MemoryMetadata implements ResourceMetadataStore {
  readonly accountId = "account";
  readonly records = new Map<string, ResourceRecord>();
  readonly catalogs = new Map<string, ResourceCatalogCheckpoint>();
  catalogCommits = 0;

  async readResource(key: { handle: string }) {
    return structuredClone(this.records.get(key.handle) ?? null);
  }

  async readAccessibleResource(_projectId: string, key: { handle: string }) {
    return this.readResource(key);
  }

  async readProjection(project: string): Promise<ResourceProjectionSnapshot> {
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
    const projected = new Map(this.records);
    for (const write of input.resources)
      projected.set(write.next.resource.handle, structuredClone(write.next));
    const identities = [...projected.values()].map(({ resource }) => resource.identity.documentId);
    if (new Set(identities).size !== identities.length) return "stale" as const;
    for (const write of input.resources)
      this.records.set(write.next.resource.handle, structuredClone(write.next));
    this.catalogs.set(key, structuredClone(input.next));
    this.catalogCommits += 1;
    return "committed" as const;
  }

  observeProjection() {
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

it("installs an external rename across an unrelated resource revision race", async () => {
  const metadata = new MemoryMetadata();
  metadata.records.set("resource", resource("before.md", 1));
  let resolveSnapshot: (value: CatalogSnapshot) => void = () => undefined;
  const catalogTransport = transport({
    snapshot: vi.fn(
      () =>
        new Promise<CatalogSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        }),
    ),
  });
  const acquisition = new ResourceCatalogAcquisition("account", metadata, catalogTransport);

  const pending = acquisition.acquire(projectId, scope);
  await vi.waitFor(() => expect(catalogTransport.snapshot).toHaveBeenCalledOnce());
  const unrelated = resource("before.md", 2);
  unrelated.resource.content = { kind: "exact", databaseName: "new-cache", schema: "0.5" };
  metadata.records.set("resource", unrelated);
  resolveSnapshot(snapshot("external.md"));
  await pending;

  expect(metadata.records.get("resource")?.resource).toMatchObject({
    revision: 3,
    content: { databaseName: "new-cache" },
    canonical: { path: "/external.md" },
  });
  expect(metadata.catalogCommits).toBe(1);
});

it("rejects a User catalog response for another account", async () => {
  const metadata = new MemoryMetadata();
  const userScope = { kind: "user", userId: "self" } as const;
  const acquisition = new ResourceCatalogAcquisition(
    "account",
    metadata,
    transport({
      snapshot: vi.fn(async () => ({
        scope: { kind: "user" as const, userId: "intruder" },
        generation: "generation",
        headRevision: "0",
        cursor: "cursor",
        entries: [],
      })),
    }),
  );

  await expect(acquisition.acquire(projectId, userScope)).rejects.toThrow("scope mismatch");
  expect(metadata.catalogCommits).toBe(0);
});

it.each([
  [{ kind: "project", projectId: "other" } as const],
  [{ kind: "user", userId: "other" } as const],
  [{ kind: "work", projectId, workId: "other" } as const],
])("rejects an initial snapshot for a different requested scope", async (responseScope) => {
  const metadata = new MemoryMetadata();
  const requested = { kind: "work", projectId, workId: "requested" } as const;
  const acquisition = new ResourceCatalogAcquisition(
    "account",
    metadata,
    transport({
      snapshot: vi.fn(async () => ({
        scope: responseScope,
        generation: "generation",
        headRevision: "0",
        cursor: "cursor",
        entries: [],
      })),
    }),
  );

  await expect(acquisition.acquire(projectId, requested)).rejects.toThrow("scope mismatch");
  expect(metadata.catalogCommits).toBe(0);
});

it("rejects a malformed request before dispatch", async () => {
  const catalogTransport = transport();
  const acquisition = new ResourceCatalogAcquisition(
    "account",
    new MemoryMetadata(),
    catalogTransport,
  );

  await expect(
    acquisition.acquire(projectId, { kind: "project", projectId: "other" }),
  ).rejects.toThrow("request scope mismatch");
  await expect(acquisition.acquire(projectId, { kind: "user", userId: "account" })).rejects.toThrow(
    "request scope mismatch",
  );
  expect(catalogTransport.snapshot).not.toHaveBeenCalled();
});

it("re-reads account resources after HTTP before discovering document identity", async () => {
  const metadata = new MemoryMetadata();
  let resolveSnapshot: (value: CatalogSnapshot) => void = () => undefined;
  const catalogTransport = transport({
    snapshot: vi.fn(
      () =>
        new Promise<CatalogSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        }),
    ),
  });
  const acquisition = new ResourceCatalogAcquisition("account", metadata, catalogTransport);

  const pending = acquisition.acquire(projectId, scope);
  await vi.waitFor(() => expect(catalogTransport.snapshot).toHaveBeenCalledOnce());
  metadata.records.set("created-during-request", {
    ...resource("local.md", 1),
    resource: { ...resource("local.md", 1).resource, handle: "created-during-request" },
  });
  resolveSnapshot(snapshot());
  await pending;

  expect(metadata.records.has("catalog:document")).toBe(false);
  expect(metadata.records.get("created-during-request")?.resource.identity.documentId).toBe(
    "document",
  );
});

it("serializes wake hints and drains to the highest revision observed in flight", async () => {
  const metadata = new MemoryMetadata();
  const cursors: string[] = [];
  let active = 0;
  let maxActive = 0;
  const pending: Array<(value: CatalogChanges) => void> = [];
  const catalogTransport = transport({
    snapshot: vi.fn(async () => snapshot("chapter.md", "0")),
    changes: vi.fn(
      async (_project, _scope, cursor) =>
        new Promise<CatalogChanges>((resolve) => {
          cursors.push(cursor);
          active += 1;
          maxActive = Math.max(maxActive, active);
          pending.push((value) => {
            active -= 1;
            resolve(value);
          });
        }),
    ),
  });
  const acquisition = new ResourceCatalogAcquisition("account", metadata, catalogTransport);
  await acquisition.acquire(projectId, scope);

  const first = acquisition.hint(projectId, scope, "1");
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  const duplicate = acquisition.hint(projectId, scope, "1");
  const highWater = acquisition.hint(projectId, scope, "2");
  expect(duplicate).toBe(first);
  expect(highWater).toBe(first);
  pending.shift()?.({
    kind: "delta",
    scope,
    commits: [
      {
        eventId: "event-1",
        commitId: "commit-1",
        firstRevision: "1",
        lastRevision: "1",
        changes: [],
      },
    ],
    nextCursor: "cursor-1",
    headRevision: "1",
    hasMore: false,
  });
  await vi.waitFor(() => expect(pending).toHaveLength(1));
  pending.shift()?.({
    kind: "delta",
    scope,
    commits: [
      {
        eventId: "event-2",
        commitId: "commit-2",
        firstRevision: "2",
        lastRevision: "2",
        changes: [],
      },
    ],
    nextCursor: "cursor-2",
    headRevision: "2",
    hasMore: false,
  });

  await expect(first).resolves.toMatchObject({ cursor: "cursor-2", appliedRevision: "2" });
  expect(cursors).toEqual(["cursor-0", "cursor-1"]);
  expect(maxActive).toBe(1);
});

it("aborts an in-flight request and installs no late checkpoint after close", async () => {
  const metadata = new MemoryMetadata();
  let requestSignal: AbortSignal | undefined;
  const acquisition = new ResourceCatalogAcquisition(
    "account",
    metadata,
    transport({
      snapshot: vi.fn(
        async (_project, _scope, signal) =>
          new Promise<CatalogSnapshot>((resolve, reject) => {
            requestSignal = signal;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            void resolve;
          }),
      ),
    }),
  );

  const acquiring = acquisition.acquire(projectId, scope);
  await vi.waitFor(() => expect(requestSignal).toBeDefined());
  acquisition.beginClose();

  await expect(acquiring).rejects.toThrow("closing");
  await expect(acquisition.finishClose()).resolves.toBeUndefined();
  expect(requestSignal?.aborted).toBe(true);
  expect(metadata.catalogs.size).toBe(0);
  expect(metadata.catalogCommits).toBe(0);
});
