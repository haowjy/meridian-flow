/** Account-qualified metadata transactions and one shared reactive projection stream. */
import type { CatalogScope } from "@meridian/contracts/protocol";
import type {
  DocumentMaterialization,
  FolderNamespaceRecord,
  FolderNamespaceStore,
  FolderNamespaceWrite,
  NamespaceIntent,
  ResourceCatalogCheckpoint,
  ResourceDescriptor,
  ResourceDestination,
  ResourceKey,
  ResourceMetadataStore,
  ResourceProjectionSnapshot,
  ResourceRecord,
  ResourceWrite,
  ServerHold,
} from "@meridian/resource-replica";
import {
  catalogProjectionKey,
  catalogScopeBelongsToProject,
  folderDeletionSettlement,
  holdAfterAttempt,
  planFolderDeletionResources,
  planFolderRemintDependents,
  resourceForDocumentIdentity,
  resourceVisibleInProject,
  untitledDestination,
  validateFolderNamespaceUpdate,
  validateResourceRecordUpdate,
} from "@meridian/resource-replica";
import Dexie, { liveQuery, type Table } from "dexie";

type StoredCatalog = ResourceCatalogCheckpoint & { key: string };
/** Account-wide counters kept beside the journals; `placementHighWater` is the highest admission order assigned. */
type StoredMeta = { key: "placementHighWater"; value: number };
/** The `create` intent kind, and a placement destination that could be absent, removed by the model change. */
type LegacyDesired =
  | {
      kind: "create";
      folderPath: string;
      provisionalName?: string;
      destination?: ResourceDestination;
    }
  | { kind: "set-location"; typedName: string; destination?: ResourceDestination }
  | { kind: "set-folder-location"; typedName: string; destination: ResourceDestination }
  | { kind: "delete" };
type LegacyIntent = Omit<NamespaceIntent, "desired"> & { desired: LegacyDesired };
type AccountProjectionSnapshot = {
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
  catalogs: readonly ResourceCatalogCheckpoint[];
};
type ProjectionListener = {
  projectId: string;
  listener(snapshot: ResourceProjectionSnapshot): void;
  onError(error: unknown): void;
};

/**
 * What the server holds under the id an older build's record now has, replayed from the create
 * attempts it recorded for that id: the same fold the journal now keeps current
 * (`holdAfterAttempt`), run once. Attempts of an earlier identity revision named an id the record
 * no longer has; what they proved (a `conflict`, say) says nothing about this one.
 */
function replayedServerHold(
  neverPlaced: boolean,
  intents: readonly LegacyIntent[],
  identityRevision: number,
): ServerHold {
  if (!neverPlaced) return "held";
  return intents
    .filter((intent) => intent.identityRevision === identityRevision)
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((intent) => intent.attempts)
    .reduce<ServerHold>((hold, attempt) => holdAfterAttempt(hold, attempt), "local");
}

/**
 * A pre-`materialization` document: the materialization its create intent recorded, and the
 * rewrite that gives each of its placements a destination. Null when nothing needs rewriting.
 */
function upgradedMaterialization(
  resource: ResourceDescriptor,
  held: readonly LegacyIntent[],
): {
  materialization: DocumentMaterialization;
  place: (intent: LegacyIntent) => NamespaceIntent;
} | null {
  const creates = held
    .filter((intent) => intent.desired.kind === "create")
    .sort((left, right) => left.sequence - right.sequence);
  const placements = held.filter(
    (intent): intent is LegacyIntent & { desired: { kind: "set-location" } } =>
      intent.desired.kind === "set-location",
  );
  if (creates.length === 0 && !placements.some((intent) => !intent.desired.destination))
    return null;
  const first = creates[0]?.desired;
  const base =
    first?.kind === "create"
      ? {
          kind: "untitled" as const,
          folderPath: first.folderPath,
          provisionalName: first.provisionalName ?? "Untitled",
        }
      : resource.materialization;
  if (!base) return null;
  // A record is unnamed only while no placement names it: the writer's first placement
  // (a filed create) means the local row no longer invites a home.
  const names = [
    ...creates.flatMap((intent) =>
      intent.desired.kind === "create" ? [intent.desired.destination] : [],
    ),
    ...placements.map((intent) => intent.desired.destination),
  ];
  const unnamed = names.length > 0 && names.every((destination) => !destination);
  return {
    materialization: {
      kind: "untitled",
      folderPath: base.folderPath,
      provisionalName: base.provisionalName,
      ...(unnamed ? { unnamed: true as const } : {}),
    },
    place: (intent) => {
      if (intent.desired.kind === "create")
        return {
          ...intent,
          desired: {
            kind: "set-location",
            typedName: base.provisionalName,
            destination:
              intent.desired.destination ??
              untitledDestination(base.folderPath, base.provisionalName),
          },
        };
      if (intent.desired.kind === "set-location" && !intent.desired.destination)
        return {
          ...intent,
          desired: {
            ...intent.desired,
            destination: untitledDestination(base.folderPath, intent.desired.typedName),
          },
        };
      return intent as NamespaceIntent;
    },
  };
}

/**
 * Expected revisions belong to the caller's immutable snapshot; stale writes never partly apply.
 * Folder placement shares the file journal's transactions, catalog commits and projection stream.
 */
export class IndexedDbResourceMetadata implements ResourceMetadataStore, FolderNamespaceStore {
  private readonly database: Dexie;
  private readonly resources: Table<ResourceDescriptor, string>;
  private readonly intents: Table<NamespaceIntent, string>;
  private readonly catalogs: Table<StoredCatalog, string>;
  private readonly folders: Table<FolderNamespaceRecord, string>;
  private readonly meta: Table<StoredMeta, string>;
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
    this.database = new Dexie(`meridian:resource-metadata:v4:${encodeURIComponent(accountId)}`);
    this.database.version(1).stores({
      resources: "handle",
      intents: "intentId,handle,projectId",
      catalogs: "key,projectId",
      folders: "handle,projectId",
    });
    this.database
      .version(2)
      .stores({})
      .upgrade(async (transaction) => {
        // A cursor with unversioned entries cannot prove canonical freshness.
        // Checkpoints are reacquirable; content identities and offline journals survive.
        await transaction.table("catalogs").clear();
      });
    // Placement admission reads only journals with work in flight, found through these indexes
    // (state, admission order, outstanding canonical refresh) instead of the account's history.
    this.database.version(3).stores({
      resources: "handle,obligations.canonicalRefresh.operationId",
      intents: "intentId,handle,projectId,state,admission.order",
      folders: "handle,projectId,canonicalRefresh.operationId",
    });
    // The admission high-water mark is one stored counter, raised in the commit that stores an
    // admitted intent, so admitting never scans the history that produced it. `operationId` finds
    // the accepted intent a canonical refresh still waits on.
    this.database
      .version(4)
      .stores({
        intents: "intentId,handle,projectId,state,admission.order,operationId",
        meta: "key",
      })
      .upgrade(async (transaction) => {
        let highest = 0;
        await transaction.table("intents").each((intent: NamespaceIntent) => {
          highest = Math.max(highest, intent.admission?.order ?? 0);
        });
        await transaction.table("folders").each((folder: FolderNamespaceRecord) => {
          for (const intent of folder.intents)
            highest = Math.max(highest, intent.admission?.order ?? 0);
        });
        await transaction.table("meta").put({ key: "placementHighWater", value: highest });
      });
    // A document's first placement is a `set-location` that always names its destination, and its
    // home comes from `materialization`. A journal written before that keeps its pending work: a
    // create intent becomes the placement it now is, and a placement with no destination (the
    // editor's nameless create) names the home its materialization records. Every document and
    // folder also gains `serverHold`, replayed from the create attempts it already recorded.
    // `folderId` and `aliases` (multi-entry) find a folder by its current or a former id.
    this.database
      .version(5)
      .stores({ folders: "handle,projectId,canonicalRefresh.operationId,folderId,*aliases" })
      .upgrade(async (transaction) => {
        const resources = transaction.table<ResourceDescriptor, string>("resources");
        const intents = transaction.table<LegacyIntent, string>("intents");
        const folders = transaction.table<FolderNamespaceRecord, string>("folders");
        for (const stored of await resources.toArray()) {
          const held = await intents.where("handle").equals(stored.handle).toArray();
          const serverHold = replayedServerHold(
            stored.lifecycle.kind === "local" && stored.canonical === null,
            held,
            stored.identity.revision,
          );
          const upgraded = upgradedMaterialization(stored, held);
          await resources.put({
            ...stored,
            serverHold,
            ...(upgraded ? { materialization: upgraded.materialization } : {}),
          });
          if (upgraded) for (const intent of held) await intents.put(upgraded.place(intent));
        }
        for (const folder of await folders.toArray())
          await folders.put({
            ...folder,
            // A folder's intents all carry identity revision 1.
            serverHold: replayedServerHold(folder.canonical === null, folder.intents, 1),
          });
      });
    this.resources = this.database.table("resources");
    this.intents = this.database.table("intents");
    this.catalogs = this.database.table("catalogs");
    this.folders = this.database.table("folders");
    this.meta = this.database.table("meta");
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
    return this.database.transaction(
      "r",
      this.resources,
      this.intents,
      this.catalogs,
      this.folders,
      async () => {
        const [resources, intents, catalogs, folders] = await Promise.all([
          this.resources.toArray(),
          this.intents.toArray(),
          this.catalogs.toArray(),
          this.folders.toArray(),
        ]);
        return {
          records: this.records(resources, intents),
          folders,
          catalogs: catalogs.map(({ key: _key, ...checkpoint }) => checkpoint),
        };
      },
    );
  }

  private projectSnapshot(
    snapshot: AccountProjectionSnapshot,
    projectId: string,
  ): ResourceProjectionSnapshot {
    return {
      records: snapshot.records,
      folders: snapshot.folders,
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

  /**
   * What admitting a placement reads: for the journals that still shape the list, only their
   * unresolved intents and the accepted one a canonical refresh waits on (found through indexes,
   * so a handle's settled history is never loaded); the optional subject's resource; every folder
   * record, which parent resolution needs; the project's catalogs; and the stored high-water
   * mark. Call it inside the placement admission lock, which makes the mark atomic with the
   * commit that follows.
   */
  readPlacementAdmissionView(
    projectId: string,
    subject?: ResourceKey,
  ): Promise<ResourceProjectionSnapshot & { highWater: number }> {
    return this.run(() =>
      this.database.transaction(
        "r",
        this.resources,
        this.intents,
        this.catalogs,
        this.folders,
        this.meta,
        async () => {
          const shaping = await this.intents
            .where("state")
            .anyOf("pending", "submitted", "received")
            .toArray();
          const refreshing = await this.resources
            .where("obligations.canonicalRefresh.operationId")
            .aboveOrEqual("")
            .toArray();
          for (const resource of refreshing) {
            const operationId = resource.obligations.canonicalRefresh?.operationId;
            if (!operationId) continue;
            shaping.push(
              ...(await this.intents.where("operationId").equals(operationId).toArray()),
            );
          }
          const handles = new Set([
            ...shaping.map((intent) => intent.handle),
            ...(subject ? [subject.handle] : []),
          ]);
          const records = this.records(
            (await this.resources.bulkGet([...handles])).filter(
              (resource) => resource !== undefined,
            ),
            shaping,
          );
          const [folders, catalogs, highWater] = await Promise.all([
            this.folders.toArray(),
            this.catalogs.where("projectId").equals(projectId).toArray(),
            this.meta.get("placementHighWater"),
          ]);
          return {
            records,
            folders,
            catalogs: catalogs.map(({ key: _key, ...checkpoint }) => checkpoint),
            highWater: highWater?.value ?? 0,
          };
        },
      ),
    );
  }

  /** Raises the stored mark to the highest admission order among intents this commit stores. */
  private async raiseHighWater(intents: Iterable<NamespaceIntent>): Promise<void> {
    let highest = 0;
    for (const intent of intents) highest = Math.max(highest, intent.admission?.order ?? 0);
    if (highest === 0) return;
    const current = await this.meta.get("placementHighWater");
    if (highest > (current?.value ?? 0))
      await this.meta.put({ key: "placementHighWater", value: highest });
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
      await this.raiseHighWater(next.intents);
    }
  }

  async commitResource(input: ResourceWrite) {
    const write = structuredClone(input);
    return this.run(() =>
      this.database.transaction("rw", this.resources, this.intents, this.meta, async () => {
        if (!(await this.isCurrent([write]))) return "stale" as const;
        await this.putResources([write]);
        return "committed" as const;
      }),
    );
  }

  readFolder(key: ResourceKey): Promise<FolderNamespaceRecord | null> {
    return this.run(async () => (await this.folders.get(key.handle)) ?? null);
  }

  /** The record a folder id names: the folder with that current id, else the one reminted from it (`folderForId`). */
  readFolderById(folderId: string): Promise<FolderNamespaceRecord | null> {
    return this.run(
      async () =>
        (await this.folders.where("folderId").equals(folderId).first()) ??
        (await this.folders.where("aliases").equals(folderId).first()) ??
        null,
    );
  }

  readFolders(projectId: string): Promise<readonly FolderNamespaceRecord[]> {
    return this.run(() =>
      this.folders
        .filter((folder) => folder.projectId === null || folder.projectId === projectId)
        .toArray(),
    );
  }

  private async foldersAreCurrent(writes: readonly FolderNamespaceWrite[]): Promise<boolean> {
    const handles = new Set<string>();
    for (const { expectedRevision, next } of writes) {
      if (handles.has(next.handle)) throw new Error("Duplicate folder write");
      handles.add(next.handle);
      const current = (await this.folders.get(next.handle)) ?? null;
      if ((current?.revision ?? null) !== expectedRevision) return false;
      validateFolderNamespaceUpdate(current, next);
    }
    return true;
  }

  async commitFolder(input: FolderNamespaceWrite) {
    const write = structuredClone(input);
    return this.run(() =>
      this.database.transaction(
        "rw",
        this.folders,
        this.resources,
        this.intents,
        this.meta,
        async () => {
          if (!(await this.foldersAreCurrent([write]))) return "stale" as const;
          const previous = (await this.folders.get(write.next.handle)) ?? null;
          const receipt = folderDeletionSettlement(previous, write.next);
          if (receipt) {
            const records = this.records(
              await this.resources.toArray(),
              await this.intents.toArray(),
            );
            const byHandle = new Map(records.map((record) => [record.resource.handle, record]));
            const descendants = planFolderDeletionResources(receipt, records);
            for (const descendant of descendants) {
              validateResourceRecordUpdate(
                byHandle.get(descendant.next.resource.handle) ?? null,
                descendant.next,
              );
            }
            await this.resources.bulkPut(descendants.map((write) => write.next.resource));
          }
          if (previous && previous.folderId !== write.next.folderId)
            await this.followRemintedFolder(previous.folderId, write.next);
          await this.folders.put(write.next);
          await this.raiseHighWater(write.next.intents);
          return "committed" as const;
        },
      ),
    );
  }

  /**
   * A folder's remint commits with the placements that named its old id: each unsent one is queued
   * again under the new id, so a child never reaches the server naming a folder it cannot use.
   */
  private async followRemintedFolder(
    previousId: string,
    reminted: FolderNamespaceRecord,
  ): Promise<void> {
    const records = this.records(await this.resources.toArray(), await this.intents.toArray());
    const folders = (await this.folders.toArray()).filter(
      (folder) => folder.handle !== reminted.handle,
    );
    const { resources, folders: followers } = planFolderRemintDependents({
      previousFolderId: previousId,
      folderId: reminted.folderId,
      records,
      folders,
    });
    const byHandle = new Map(records.map((record) => [record.resource.handle, record]));
    for (const write of resources)
      validateResourceRecordUpdate(byHandle.get(write.next.resource.handle) ?? null, write.next);
    for (const write of followers)
      validateFolderNamespaceUpdate(
        folders.find((folder) => folder.handle === write.next.handle) ?? null,
        write.next,
      );
    await this.putResources(resources);
    await this.folders.bulkPut(followers.map(({ next }) => next));
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
      this.database.transaction(
        "rw",
        this.catalogs,
        this.resources,
        this.intents,
        this.folders,
        this.meta,
        async () => {
          if (!catalogScopeBelongsToProject(input.next.projectId, input.next.scope))
            throw new Error("Catalog scope belongs to another project");
          const key = catalogProjectionKey(input.next.projectId, input.next.scope);
          const current = await this.catalogs.get(key);
          if (
            (current?.revision ?? null) !== input.expectedRevision ||
            !(await this.isCurrent(input.resources)) ||
            !(await this.foldersAreCurrent(input.folders))
          )
            return "stale" as const;
          if (input.next.revision !== (input.expectedRevision ?? 0) + 1)
            throw new Error("Invalid catalog revision");
          await this.putResources(input.resources);
          await this.folders.bulkPut(input.folders.map(({ next }) => next));
          await this.raiseHighWater(input.folders.flatMap(({ next }) => next.intents));
          await this.catalogs.put({
            ...input.next,
            key,
          });
          return "committed" as const;
        },
      ),
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
