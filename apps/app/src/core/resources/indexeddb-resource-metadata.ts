/** Account-qualified metadata transactions and one shared reactive projection stream. */
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
  resourceForDocumentIdentity,
  resourceVisibleInProject,
  validateResourceRecordUpdate,
} from "@meridian/resource-replica";
import Dexie, { liveQuery, type Table } from "dexie";

type StoredCatalog = ResourceCatalogCheckpoint & { key: string };
type AccountProjectionSnapshot = {
  records: readonly ResourceRecord[];
  catalogs: readonly ResourceCatalogCheckpoint[];
};
type ProjectionListener = {
  projectId: string;
  listener(snapshot: ResourceProjectionSnapshot): void;
  onError(error: unknown): void;
};

/** Expected revisions belong to the caller's immutable snapshot; stale writes never partly apply. */
export class IndexedDbResourceMetadata implements ResourceMetadataStore {
  private readonly database: Dexie;
  private readonly resources: Table<ResourceDescriptor, string>;
  private readonly intents: Table<NamespaceIntent, string>;
  private readonly catalogs: Table<StoredCatalog, string>;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly projectionListeners = new Map<symbol, ProjectionListener>();
  private projectionStop: (() => void) | null = null;
  private projectionRetry: ReturnType<typeof setTimeout> | null = null;
  private projectionSnapshot: AccountProjectionSnapshot | null = null;
  private closing = false;

  constructor(
    readonly accountId: string,
    onVersionChange: () => void,
  ) {
    this.database = new Dexie(`meridian:resource-metadata:v3:${encodeURIComponent(accountId)}`);
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

  private records(
    resources: readonly ResourceDescriptor[],
    intents: readonly NamespaceIntent[],
  ): ResourceRecord[] {
    const byHandle = new Map<string, NamespaceIntent[]>();
    for (const intent of intents) {
      const members = byHandle.get(intent.handle) ?? [];
      members.push(intent);
      byHandle.set(intent.handle, members);
    }
    return resources.map((resource) => ({
      resource,
      intents: (byHandle.get(resource.handle) ?? []).sort((a, b) => a.sequence - b.sequence),
    }));
  }

  private readAccountProjection(): Promise<AccountProjectionSnapshot> {
    return this.database.transaction("r", this.resources, this.intents, this.catalogs, async () => {
      const [resources, intents, catalogs] = await Promise.all([
        this.resources.toArray(),
        this.intents.toArray(),
        this.catalogs.toArray(),
      ]);
      return {
        records: this.records(resources, intents),
        catalogs: catalogs.map(({ key: _key, ...checkpoint }) => checkpoint),
      };
    });
  }

  private projectSnapshot(
    snapshot: AccountProjectionSnapshot,
    projectId: string,
  ): ResourceProjectionSnapshot {
    return {
      records: snapshot.records,
      catalogs: snapshot.catalogs.filter((catalog) => catalog.projectId === projectId),
    };
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

  /** Resolve current identity before aliases inside one metadata snapshot. */
  resolveAccessibleResource(projectId: string, documentId: string): Promise<ResourceRecord | null> {
    return this.run(() =>
      this.database.transaction("r", this.resources, this.intents, this.catalogs, async () => {
        const [resources, intents, catalogs] = await Promise.all([
          this.resources.toArray(),
          this.intents.toArray(),
          this.catalogs.where("projectId").equals(projectId).toArray(),
        ]);
        const checkpoints = catalogs.map(({ key: _key, ...checkpoint }) => checkpoint);
        const visible = this.records(resources, intents).filter((record) =>
          resourceVisibleInProject(projectId, record, checkpoints),
        );
        return resourceForDocumentIdentity(visible, documentId);
      }),
    );
  }

  readProjection(projectId: string): Promise<ResourceProjectionSnapshot> {
    return this.run(async () =>
      this.projectSnapshot(await this.readAccountProjection(), projectId),
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
    const token = Symbol(projectId);
    this.projectionListeners.set(token, { projectId, listener, onError });
    if (this.projectionSnapshot) {
      const current = this.projectSnapshot(this.projectionSnapshot, projectId);
      queueMicrotask(() => {
        if (this.projectionListeners.has(token)) listener(current);
      });
    }
    this.startProjection();
    const stop = () => {
      this.projectionListeners.delete(token);
      if (this.projectionListeners.size > 0) return;
      this.projectionStop?.();
      if (this.projectionRetry) clearTimeout(this.projectionRetry);
      this.projectionRetry = null;
    };
    return stop;
  }

  private startProjection(): void {
    if (this.closing || this.projectionStop || this.projectionListeners.size === 0) return;
    const subscription = liveQuery(() => this.run(() => this.readAccountProjection())).subscribe({
      next: (snapshot) => {
        this.projectionSnapshot = snapshot;
        for (const subscriber of this.projectionListeners.values())
          subscriber.listener(this.projectSnapshot(snapshot, subscriber.projectId));
      },
      error: (error) => {
        for (const subscriber of this.projectionListeners.values()) subscriber.onError(error);
        this.projectionStop?.();
        if (this.closing || this.projectionListeners.size === 0 || this.projectionRetry) return;
        this.projectionRetry = setTimeout(() => {
          this.projectionRetry = null;
          this.startProjection();
        }, 1_000);
      },
    });
    this.projectionStop = () => {
      subscription.unsubscribe();
      this.projectionStop = null;
      this.projectionSnapshot = null;
    };
  }

  beginClose(): void {
    this.closing = true;
    this.projectionListeners.clear();
    this.projectionStop?.();
    if (this.projectionRetry) clearTimeout(this.projectionRetry);
    this.projectionRetry = null;
  }

  async finishClose(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.operations]);
    this.database.close({ disableAutoOpen: true });
  }
}
