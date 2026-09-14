/** Account-qualified metadata transactions. Not composed until the resource-owner cutover. */
import type { CatalogScope } from "@meridian/contracts/protocol";
import type {
  NamespaceIntent,
  ResourceCatalogCheckpoint,
  ResourceDescriptor,
  ResourceKey,
  ResourceMetadataStore,
  ResourceProjectionSnapshot,
  ResourceRecord,
  ResourceWrite,
} from "@meridian/resource-replica";
import {
  catalogProjectionKey,
  catalogScopeBelongsToProject,
  resourceVisibleInProject,
  validateResourceRecordUpdate,
} from "@meridian/resource-replica";
import Dexie, { liveQuery, type Table } from "dexie";

type StoredCatalog = ResourceCatalogCheckpoint & { key: string };

/** Expected revisions belong to the caller's immutable snapshot; stale writes never partly apply. */
export class IndexedDbResourceMetadata implements ResourceMetadataStore {
  private readonly database: Dexie;
  private readonly resources: Table<ResourceDescriptor, string>;
  private readonly intents: Table<NamespaceIntent, string>;
  private readonly catalogs: Table<StoredCatalog, string>;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly subscriptions = new Set<() => void>();
  private closing = false;

  constructor(
    readonly accountId: string,
    onVersionChange: () => void,
  ) {
    this.database = new Dexie(`meridian:resource-metadata:v2:${encodeURIComponent(accountId)}`);
    this.database.version(1).stores({
      resources: "handle",
      intents: "intentId,handle,projectId",
      catalogs: "key,projectId",
    });
    this.resources = this.database.table("resources");
    this.intents = this.database.table("intents");
    this.catalogs = this.database.table("catalogs");
    this.database.on("versionchange", () => {
      this.beginClose();
      try {
        onVersionChange();
      } finally {
        void this.finishClose();
      }
      return false;
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Resource metadata is closing"));
    const promise = Promise.resolve().then(operation);
    this.operations.add(promise);
    void promise.finally(() => this.operations.delete(promise)).catch(() => undefined);
    return promise;
  }

  private async record(resource: ResourceDescriptor): Promise<ResourceRecord> {
    const intents = await this.intents.where("handle").equals(resource.handle).toArray();
    intents.sort((a, b) => a.sequence - b.sequence);
    return { resource, intents };
  }

  readResource(key: ResourceKey): Promise<ResourceRecord | null> {
    return this.run(() =>
      this.database.transaction("r", this.resources, this.intents, async () => {
        const resource = await this.resources.get(key.handle);
        return resource ? this.record(resource) : null;
      }),
    );
  }

  readAccessibleResource(projectId: string, key: ResourceKey): Promise<ResourceRecord | null> {
    return this.run(() =>
      this.database.transaction("r", this.resources, this.intents, this.catalogs, async () => {
        const resource = await this.resources.get(key.handle);
        if (!resource) return null;
        const [record, catalogs] = await Promise.all([
          this.record(resource),
          this.catalogs.where("projectId").equals(projectId).toArray(),
        ]);
        const checkpoints = catalogs.map(({ key: _key, ...checkpoint }) => checkpoint);
        return resourceVisibleInProject(projectId, record, checkpoints) ? record : null;
      }),
    );
  }

  readProjection(projectId: string): Promise<ResourceProjectionSnapshot> {
    return this.run(() =>
      this.database.transaction("r", this.resources, this.intents, this.catalogs, async () => {
        const resources = await this.resources.toArray();
        const catalogs = await this.catalogs.where("projectId").equals(projectId).toArray();
        return {
          records: await Promise.all(resources.map((resource) => this.record(resource))),
          catalogs: catalogs.map(({ key: _key, ...checkpoint }) => checkpoint),
        };
      }),
    );
  }

  private async isCurrent(writes: readonly ResourceWrite[]): Promise<boolean> {
    const keys = new Set<string>();
    const intentKeys = new Set<string>();
    for (const { expectedRevision, next } of writes) {
      const resource = next.resource;
      const key = resource.handle;
      if (keys.has(key)) throw new Error("Duplicate resource write");
      keys.add(key);
      const current = await this.resources.get(resource.handle);
      if ((current?.revision ?? null) !== expectedRevision) return false;
      validateResourceRecordUpdate(current ? await this.record(current) : null, next);
      for (const intent of next.intents) {
        const key = intent.intentId;
        const existing = await this.intents.get(intent.intentId);
        if (intentKeys.has(key) || (existing && existing.handle !== intent.handle))
          throw new Error("Namespace intent belongs to another resource");
        intentKeys.add(key);
      }
    }
    const projected = new Map(
      (await this.resources.toArray()).map((resource) => [resource.handle, resource] as const),
    );
    for (const { next } of writes) projected.set(next.resource.handle, next.resource);
    const documentIds = new Set<string>();
    for (const resource of projected.values()) {
      if (documentIds.has(resource.identity.documentId)) return false;
      documentIds.add(resource.identity.documentId);
    }
    return true;
  }

  private async putResources(writes: readonly ResourceWrite[]): Promise<void> {
    for (const { next } of writes) {
      await this.resources.put(next.resource);
      await this.intents.bulkPut([...next.intents]);
    }
  }

  async commitResource(input: ResourceWrite) {
    const write = structuredClone(input);
    return this.run(() =>
      this.database.transaction("rw", this.resources, this.intents, async () => {
        if (!(await this.isCurrent([write]))) return "stale" as const;
        await this.putResources([write]);
        return "committed" as const;
      }),
    );
  }

  readCatalog(projectId: string, scope: CatalogScope): Promise<ResourceCatalogCheckpoint | null> {
    const key = catalogProjectionKey(projectId, scope);
    return this.run(async () => {
      const stored = await this.catalogs.get(key);
      if (!stored) return null;
      const { key: _key, ...checkpoint } = stored;
      return checkpoint;
    });
  }

  async commitCatalog(command: Parameters<ResourceMetadataStore["commitCatalog"]>[0]) {
    const input = structuredClone(command);
    return this.run(() =>
      this.database.transaction("rw", this.catalogs, this.resources, this.intents, async () => {
        if (!catalogScopeBelongsToProject(input.next.projectId, input.next.scope))
          throw new Error("Catalog scope belongs to another project");
        const key = catalogProjectionKey(input.next.projectId, input.next.scope);
        const current = await this.catalogs.get(key);
        if (
          (current?.revision ?? null) !== input.expectedRevision ||
          !(await this.isCurrent(input.resources))
        )
          return "stale" as const;
        if (input.next.revision !== (input.expectedRevision ?? 0) + 1)
          throw new Error("Invalid catalog revision");
        await this.putResources(input.resources);
        await this.catalogs.put({
          ...input.next,
          key,
        });
        return "committed" as const;
      }),
    );
  }

  observeProjection(
    projectId: string,
    listener: (snapshot: ResourceProjectionSnapshot) => void,
    onError: (error: unknown) => void,
  ): () => void {
    if (this.closing) throw new Error("Resource metadata is closing");
    const subscription = liveQuery(() =>
      this.run(() =>
        this.database.transaction("r", this.resources, this.intents, this.catalogs, async () => {
          const resources = await this.resources.toArray();
          const catalogs = await this.catalogs.where("projectId").equals(projectId).toArray();
          return {
            records: await Promise.all(resources.map((resource) => this.record(resource))),
            catalogs: catalogs.map(({ key: _key, ...checkpoint }) => checkpoint),
          };
        }),
      ),
    ).subscribe({ next: listener, error: onError });
    const stop = () => {
      subscription.unsubscribe();
      this.subscriptions.delete(stop);
    };
    this.subscriptions.add(stop);
    return stop;
  }

  beginClose(): void {
    this.closing = true;
    for (const stop of this.subscriptions) stop();
  }

  async finishClose(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.operations]);
    this.database.close({ disableAutoOpen: true });
  }
}
