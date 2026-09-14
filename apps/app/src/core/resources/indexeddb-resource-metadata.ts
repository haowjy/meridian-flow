/** Account-qualified metadata transactions. Not composed until the resource-owner cutover. */
import type { CatalogScope } from "@meridian/contracts/protocol";
import type {
  MigrationEvidence,
  NamespaceIntent,
  ProjectResourceSnapshot,
  ResourceCatalogCheckpoint,
  ResourceDescriptor,
  ResourceKey,
  ResourceMetadataStore,
  ResourceMigrationCheckpoint,
  ResourceRecord,
  ResourceWrite,
} from "@meridian/resource-replica";
import { validateResourceRecordUpdate } from "@meridian/resource-replica";
import Dexie, { liveQuery, type Table } from "dexie";

type StoredCatalog = ResourceCatalogCheckpoint & { key: string; projectId: string };
type StoredCheckpoint = ResourceMigrationCheckpoint & { key: "migration" };

function scopeKey(scope: CatalogScope): string {
  switch (scope.kind) {
    case "user":
      return JSON.stringify([scope.kind, scope.userId]);
    case "work":
      return JSON.stringify([scope.kind, scope.projectId, scope.workId]);
    default:
      return JSON.stringify([scope.kind, scope.projectId]);
  }
}

/** Expected revisions belong to the caller's immutable snapshot; stale writes never partly apply. */
export class IndexedDbResourceMetadata implements ResourceMetadataStore {
  private readonly database: Dexie;
  private readonly resources: Table<ResourceDescriptor, [string, string]>;
  private readonly intents: Table<NamespaceIntent, [string, string]>;
  private readonly catalogs: Table<StoredCatalog, string>;
  private readonly evidence: Table<MigrationEvidence, string>;
  private readonly checkpoints: Table<StoredCheckpoint, string>;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly subscriptions = new Set<() => void>();
  private closing = false;

  constructor(
    readonly accountId: string,
    onVersionChange: () => void,
  ) {
    this.database = new Dexie(`meridian:resource-metadata:v1:${encodeURIComponent(accountId)}`);
    this.database.version(1).stores({
      resources: "[projectId+handle],projectId",
      intents: "[projectId+intentId],[projectId+handle]",
      catalogs: "key,projectId",
      evidence: "sourceKey",
      checkpoints: "key",
    });
    this.resources = this.database.table("resources");
    this.intents = this.database.table("intents");
    this.catalogs = this.database.table("catalogs");
    this.evidence = this.database.table("evidence");
    this.checkpoints = this.database.table("checkpoints");
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
    const intents = await this.intents
      .where("[projectId+handle]")
      .equals([resource.projectId, resource.handle])
      .toArray();
    intents.sort((a, b) => a.sequence - b.sequence);
    return { resource, intents };
  }

  readResource(key: ResourceKey): Promise<ResourceRecord | null> {
    const identity: [string, string] = [key.projectId, key.handle];
    return this.run(() =>
      this.database.transaction("r", this.resources, this.intents, async () => {
        const resource = await this.resources.get(identity);
        return resource ? this.record(resource) : null;
      }),
    );
  }

  private async isCurrent(writes: readonly ResourceWrite[]): Promise<boolean> {
    const keys = new Set<string>();
    const intentKeys = new Set<string>();
    for (const { expectedRevision, next } of writes) {
      const resource = next.resource;
      const key = JSON.stringify([resource.projectId, resource.handle]);
      if (keys.has(key)) throw new Error("Duplicate resource write");
      keys.add(key);
      const current = await this.resources.get([resource.projectId, resource.handle]);
      if ((current?.revision ?? null) !== expectedRevision) return false;
      validateResourceRecordUpdate(current ? await this.record(current) : null, next);
      for (const intent of next.intents) {
        const key = JSON.stringify([intent.projectId, intent.intentId]);
        const existing = await this.intents.get([intent.projectId, intent.intentId]);
        if (intentKeys.has(key) || (existing && existing.handle !== intent.handle))
          throw new Error("Namespace intent belongs to another resource");
        intentKeys.add(key);
      }
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

  readCatalog(scope: CatalogScope): Promise<ResourceCatalogCheckpoint | null> {
    const key = scopeKey(scope);
    return this.run(async () => {
      const stored = await this.catalogs.get(key);
      if (!stored) return null;
      const { key: _key, projectId: _projectId, ...checkpoint } = stored;
      return checkpoint;
    });
  }

  async commitCatalog(command: Parameters<ResourceMetadataStore["commitCatalog"]>[0]) {
    const input = structuredClone(command);
    return this.run(() =>
      this.database.transaction("rw", this.catalogs, this.resources, this.intents, async () => {
        const key = scopeKey(input.next.scope);
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
          projectId: input.next.scope.kind === "user" ? "" : input.next.scope.projectId,
        });
        return "committed" as const;
      }),
    );
  }

  readMigration() {
    return this.run(() =>
      this.database.transaction("r", this.checkpoints, this.evidence, async () => {
        const stored = await this.checkpoints.get("migration");
        const checkpoint = stored ? { revision: stored.revision, state: stored.state } : null;
        return { checkpoint, evidence: await this.evidence.toArray() };
      }),
    );
  }

  async commitMigration(command: Parameters<ResourceMetadataStore["commitMigration"]>[0]) {
    const input = structuredClone(command);
    return this.run(() =>
      this.database.transaction(
        "rw",
        this.checkpoints,
        this.evidence,
        this.resources,
        this.intents,
        async () => {
          const current = await this.checkpoints.get("migration");
          if (
            (current?.revision ?? null) !== input.expectedRevision ||
            !(await this.isCurrent(input.resources))
          )
            return "stale" as const;
          if (input.next.revision !== (input.expectedRevision ?? 0) + 1)
            throw new Error("Invalid migration revision");
          if (current?.state === "complete") throw new Error("Completed migration cannot restart");
          const sourceKeys = new Set<string>();
          for (const item of input.evidence) {
            if (sourceKeys.has(item.sourceKey)) throw new Error("Duplicate migration evidence");
            sourceKeys.add(item.sourceKey);
            const previous = await this.evidence.get(item.sourceKey);
            if (
              previous &&
              (previous.raw !== item.raw ||
                (previous.status === "imported" && item.status !== "imported"))
            )
              throw new Error("Recorded migration evidence cannot be replaced");
          }
          await this.putResources(input.resources);
          await this.evidence.bulkPut([...input.evidence]);
          await this.checkpoints.put({ ...input.next, key: "migration" });
          return "committed" as const;
        },
      ),
    );
  }

  async resolveMigrationEvidence(
    command: Parameters<ResourceMetadataStore["resolveMigrationEvidence"]>[0],
  ) {
    const input = structuredClone(command);
    return this.run(() =>
      this.database.transaction(
        "rw",
        this.checkpoints,
        this.evidence,
        this.resources,
        this.intents,
        async () => {
          const checkpoint = await this.checkpoints.get("migration");
          if (checkpoint?.state !== "complete") throw new Error("Legacy capture is incomplete");
          const evidence = await this.evidence.get(input.sourceKey);
          if (
            evidence?.status !== "recovery" ||
            evidence.raw !== input.expectedRaw ||
            !(await this.isCurrent([input.resource]))
          )
            return "stale" as const;
          await this.putResources([input.resource]);
          await this.evidence.put({
            sourceKey: evidence.sourceKey,
            raw: evidence.raw,
            status: "imported",
          });
          return "committed" as const;
        },
      ),
    );
  }

  observeProject(
    projectId: string,
    listener: (snapshot: ProjectResourceSnapshot) => void,
    onError: (error: unknown) => void,
  ): () => void {
    if (this.closing) throw new Error("Resource metadata is closing");
    const subscription = liveQuery(() =>
      this.run(() =>
        this.database.transaction("r", this.resources, this.intents, this.catalogs, async () => {
          const resources = await this.resources.where("projectId").equals(projectId).toArray();
          const catalogs = await this.catalogs.where("projectId").anyOf(projectId, "").toArray();
          return {
            records: await Promise.all(resources.map((resource) => this.record(resource))),
            catalogs: catalogs.map(
              ({ key: _key, projectId: _projectId, ...checkpoint }) => checkpoint,
            ),
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
