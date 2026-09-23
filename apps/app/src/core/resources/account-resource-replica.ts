/** Sole browser account owner for durable resource metadata, content, catalogs, and namespace work. */
import type { CatalogScope } from "@meridian/contracts/protocol";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import {
  acknowledgeLocalResourceCleanup,
  acknowledgeResourceTerminalCleanup,
  markResourceCreateEligible,
  planCachedSessionAdoption,
  planResourceDeletion,
  planResourceLocation,
  projectResourceLocation,
  publishResourceTerminal,
  ResourceCatalogAcquisition,
  type ResourceKey,
  type ResourceLocation,
  type ResourceProjectionSnapshot,
  type ResourceRecord,
  reconcileResourceNamespace,
  recordAcquiredResourceContent,
  remintCreateConflict,
  reserveResourceDocument,
  resourceNeedsBackgroundReconciliation,
  resourceVisibleInProject,
} from "@meridian/resource-replica";
import { lookupProjectContextAvailability } from "@/client/query/project-context-availability";
import { nativeLocks } from "@/core/cross-context-locks";
import type { AccountDocumentSessionRuntime } from "@/core/editor/account-document-session-runtime";
import type { DocumentSession } from "@/core/editor/document-session";
import type { TerminalLineageReceipt } from "@/core/editor/document-session-authority-store";
import type {
  LocalLineageTerminalOperation,
  LocalLineageTerminalPort,
} from "@/core/editor/document-session-coordination-contract";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import { createResourceCatalogTransport } from "./resource-catalog-transport";
import type { ResourceContentOpenResult } from "./resource-content-access";
import { ResourceContentAccess } from "./resource-content-access";
import { createResourceNamespaceLock } from "./resource-namespace-lock";
import { createResourceNamespaceTransport } from "./resource-namespace-transport";
import { ResourceSessionAdoptionCoordinator } from "./resource-session-adoption";

function exactPersistenceName(accountId: string, persistenceId: string): string {
  return `meridian:resource:${collabSchemaKeyTag()}:${encodeURIComponent(accountId)}:${encodeURIComponent(persistenceId)}`;
}

type OrderedLocationOperation = { generation: number; tail: Promise<void> };

type KnownDocument = { key: ResourceKey; record: ResourceRecord };
export type KnownDocumentOpenResult =
  | { kind: "missing" }
  | { kind: "cancelled" }
  | {
      kind: "unavailable";
      reason: Exclude<ResourceContentOpenResult, { kind: "opened" | "cancelled" }>["reason"];
      key: ResourceKey;
      record: ResourceRecord;
    }
  | {
      kind: "opened";
      key: ResourceKey;
      record: ResourceRecord;
      handle: Extract<ResourceContentOpenResult, { kind: "opened" }>["handle"];
    };

/** Recheck mutable Document ID ownership after opening exact content. */
export async function openIdentityLinearized(input: {
  read(): Promise<KnownDocument | null>;
  open(key: ResourceKey): Promise<ResourceContentOpenResult>;
}): Promise<KnownDocumentOpenResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const known = await input.read();
    if (!known) return { kind: "missing" };
    const opened = await input.open(known.key);
    if (opened.kind === "cancelled") return opened;
    const current = await input.read();
    if (opened.kind === "opened") {
      if (
        current?.key.handle === known.key.handle &&
        current.record.resource.identity.documentId === opened.handle.documentId
      )
        return { kind: "opened", ...current, handle: opened.handle };
      opened.handle.release();
    } else if (opened.reason !== "changed" && current?.key.handle === known.key.handle) {
      return { ...opened, key: known.key, record: current.record };
    }
  }
  const current = await input.read();
  return current ? { kind: "unavailable", reason: "changed", ...current } : { kind: "missing" };
}

/** Preserve writer command order while reporting whether a completion still owns presentation. */
export class ResourceLocationOperationQueue {
  private readonly operations = new Map<string, OrderedLocationOperation>();

  run(key: ResourceKey, commit: () => Promise<void>): Promise<{ isLatest: boolean }> {
    const id = encodeURIComponent(key.handle);
    const operation = this.operations.get(id) ?? { generation: 0, tail: Promise.resolve() };
    const generation = ++operation.generation;
    const run = operation.tail.then(commit);
    operation.tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.operations.set(id, operation);
    void operation.tail.then(() => {
      if (operation.generation === generation && this.operations.get(id) === operation)
        this.operations.delete(id);
    });
    return run.then(() => ({ isLatest: operation.generation === generation }));
  }
}

export class AccountResourceReplica {
  private readonly metadata: IndexedDbResourceMetadata;
  private readonly content: ResourceContentAccess;
  private readonly catalogs: ResourceCatalogAcquisition;
  readonly terminal: LocalLineageTerminalPort;
  private readonly lock;
  private readonly lockLifetime = new AbortController();
  private readonly namespace;
  private readonly adoption;
  private readonly runners = new Map<string, Promise<void>>();
  private readonly reruns = new Map<string, ResourceKey>();
  private readonly projectionStreams = new Map<
    string,
    {
      listeners: Map<(snapshot: ResourceProjectionSnapshot) => void, (error: unknown) => void>;
      stop: () => void;
      snapshot: ResourceProjectionSnapshot | null;
    }
  >();
  private readonly observedResourceRevisions = new Map<string, number>();
  private readonly serverSessionCaptures = new Map<string, Promise<void>>();
  private reservationTail: Promise<void> = Promise.resolve();
  private readonly reservationLocks = nativeLocks();
  private readonly locationOperations = new ResourceLocationOperationQueue();
  private retryTimer: number | null = null;
  private started = false;
  private stopReconciliation: (() => void) | null = null;
  private readonly retryAll = () => {
    void this.metadata
      .readProjection("")
      .then(({ records }) => {
        for (const record of records) {
          if (resourceNeedsBackgroundReconciliation(record)) this.schedule(record.resource);
        }
      })
      .catch(() => undefined);
  };
  private closing = false;

  constructor(
    readonly accountId: string,
    private readonly runtime: AccountDocumentSessionRuntime,
    onInvalidated: (error: Error) => void = () => undefined,
  ) {
    if (runtime.accountId !== accountId) throw new Error("Resource replica account mismatch");
    this.metadata = new IndexedDbResourceMetadata(accountId, () => {
      const error = new Error("Resource storage changed in another browser context");
      this.beginClose();
      onInvalidated(error);
    });
    this.lock = createResourceNamespaceLock({ accountId, epoch: this.lockLifetime.signal });
    this.namespace = createResourceNamespaceTransport(accountId, runtime.epochSignal);
    this.content = new ResourceContentAccess(
      accountId,
      this.metadata,
      runtime.localConstruction,
      runtime.epochSignal,
    );
    this.catalogs = new ResourceCatalogAcquisition(
      accountId,
      this.metadata,
      createResourceCatalogTransport(accountId),
    );
    this.adoption = new ResourceSessionAdoptionCoordinator(
      accountId,
      this.metadata,
      this.content,
      runtime.localReservation,
      runtime.localAdoption,
      this.lock,
      {
        resolve: async (projectId, documentId, signal) => {
          try {
            const result = await lookupProjectContextAvailability(projectId, [documentId], signal);
            const resolution = result.resolutions[0];
            return resolution?.kind === "available"
              ? {
                  kind: "available" as const,
                  documentId: resolution.documentId,
                  generation: resolution.generation,
                }
              : { kind: "unavailable" as const };
          } catch {
            return signal.aborted ? Promise.reject(signal.reason) : { kind: "failed" as const };
          }
        },
      },
    );
    this.terminal = {
      continueTerminal: (input, run) => this.continueTerminal(input, run),
    };
  }

  async reserveDocument(
    projectId: string,
    folderPath = "",
  ): Promise<{
    key: ResourceKey;
    name: string;
    content: ResourceContentOpenResult;
  }> {
    this.requireOpen();
    if (this.reservationLocks) {
      return this.reservationLocks.request(
        `meridian:resource:v2:reservation/${encodeURIComponent(this.accountId)}/${encodeURIComponent(projectId)}`,
        { mode: "exclusive", signal: this.lockLifetime.signal },
        async (lock) => {
          if (!lock) throw new Error("Resource reservation lock is unavailable");
          this.requireOpen();
          return this.reserveDocumentSerial(projectId, folderPath);
        },
      );
    }
    const before = this.reservationTail;
    let release!: () => void;
    this.reservationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await this.reserveDocumentSerial(projectId, folderPath);
    } finally {
      release();
    }
  }

  private async reserveDocumentSerial(
    projectId: string,
    folderPath: string,
  ): Promise<{
    key: ResourceKey;
    name: string;
    content: ResourceContentOpenResult;
  }> {
    const key = { handle: crypto.randomUUID() };
    const documentId = crypto.randomUUID();
    const projection = await this.metadata.readProjection(projectId);
    const names = new Set(
      projection.records.flatMap((record) => {
        if (!resourceVisibleInProject(projectId, record, projection.catalogs)) return [];
        const name = projectResourceLocation(projectId, record)?.name;
        return name ? [name] : [];
      }),
    );
    let ordinal = 1;
    let name = "Untitled";
    while (names.has(name)) {
      ordinal += 1;
      name = `Untitled ${ordinal}`;
    }
    const write = reserveResourceDocument({
      projectId,
      handle: key.handle,
      documentId,
      databaseName: exactPersistenceName(this.accountId, crypto.randomUUID()),
      schema: collabSchemaKeyTag(),
      intentId: crypto.randomUUID(),
      folderPath,
      provisionalName: name,
    });
    if ((await this.metadata.commitResource(write)) !== "committed")
      throw new Error("Resource identity reservation collided");
    const content = await this.content.open(projectId, key, `reservation:${key.handle}`);
    return { key, name, content };
  }

  start(): void {
    this.requireOpen();
    if (this.started) return;
    this.started = true;
    window.addEventListener("focus", this.retryAll);
    window.addEventListener("online", this.retryAll);
    this.retryTimer = window.setInterval(this.retryAll, 30_000);
    // Reconciliation belongs to the account lifetime, not mounted catalog consumers.
    this.stopReconciliation = this.metadata.observeProjection(
      "",
      ({ records }) => {
        if (!this.closing) this.reconcileProjectionRecords(records);
      },
      () => undefined,
    );
  }

  async markCreateEligible(key: ResourceKey): Promise<void> {
    this.requireOpen();
    await this.commitPlan(key, (record) => markResourceCreateEligible(record, Date.now()));
    this.schedule(key);
  }

  async openDocument(
    projectId: string,
    key: ResourceKey,
    participantId: string,
    signal?: AbortSignal,
    options: { adoptionEligible?: boolean } = {},
  ): Promise<ResourceContentOpenResult> {
    this.requireOpen();
    await this.waitForServerSessionCaptures(encodeURIComponent(key.handle));
    this.requireOpen();
    const opened = await this.content.open(projectId, key, participantId, signal, options);
    if (opened.kind === "opened") {
      void this.reconcileOpenedProjectOwnership(projectId, key, opened.handle.session).catch(
        () => undefined,
      );
    }
    return opened;
  }

  private async reconcileOpenedProjectOwnership(
    projectId: string,
    key: ResourceKey,
    session: DocumentSession,
  ): Promise<void> {
    let ownership = this.content.ownershipFor(key, projectId);
    if (ownership === "local") {
      await this.commitPlan(key, (record) =>
        planCachedSessionAdoption({ record, projectId, transitionId: crypto.randomUUID() }),
      );
      this.schedule(key);
    }
    const runner = this.runners.get(encodeURIComponent(key.handle));
    if (runner) await runner;
    if (this.closing) return;
    ownership = this.content.ownershipFor(key, projectId);
    if (ownership !== "registry-other") return;
    const resolved = await lookupProjectContextAvailability(projectId, [session.documentId]);
    const available = resolved.resolutions[0];
    if (available?.kind !== "available" || available.documentId !== session.documentId) return;
    await this.installProjectRegistryOwnership(projectId, key, available.generation, session);
  }

  async keyForDocument(projectId: string, documentId: string): Promise<ResourceKey | null> {
    const record = await this.metadata.resolveAccessibleResource(projectId, documentId);
    return record ? { handle: record.resource.handle } : null;
  }

  async lineageHandleFor(projectId: string, documentId: string): Promise<string | null> {
    return (await this.keyForDocument(projectId, documentId))?.handle ?? null;
  }

  async readKnownDocument(
    projectId: string,
    documentId: string,
  ): Promise<{ key: ResourceKey; record: ResourceRecord } | null> {
    const record = await this.metadata.resolveAccessibleResource(projectId, documentId);
    return record ? { key: { handle: record.resource.handle }, record } : null;
  }

  /** Resolve identity and prove exact local content against one current metadata snapshot. */
  async openKnownDocument(
    projectId: string,
    documentId: string,
    participantId: string,
    signal?: AbortSignal,
  ): Promise<KnownDocumentOpenResult> {
    return openIdentityLinearized({
      read: () => this.readKnownDocument(projectId, documentId),
      open: (key) => this.openDocument(projectId, key, participantId, signal),
    });
  }

  async canAcquireRemoteDocument(projectId: string, documentId: string): Promise<boolean> {
    const known = await this.readKnownDocument(projectId, documentId);
    return Boolean(
      known &&
        known.record.resource.lifecycle.kind === "acknowledged" &&
        projectResourceLocation(projectId, known.record),
    );
  }

  /** Persist the exact cache incarnation and retain the registry's existing Y.Doc. */
  async captureServerSession(
    projectId: string,
    documentId: string,
    generation: string,
    session: DocumentSession,
  ): Promise<void> {
    this.requireOpen();
    const key = await this.keyForDocument(projectId, documentId);
    const databaseName = session.persistenceName;
    if (!key || !databaseName || session.documentId !== documentId) return;
    this.requireOpen();
    const captureId = encodeURIComponent(key.handle);
    const priorCapture = this.serverSessionCaptures.get(captureId);
    let finishCapture!: () => void;
    const capture = new Promise<void>((resolve) => {
      finishCapture = resolve;
    });
    const captureTail = priorCapture ? priorCapture.then(() => capture) : capture;
    this.serverSessionCaptures.set(captureId, captureTail);
    try {
      await session.whenSynced();
      await priorCapture;
      this.requireOpen();
      const snapshot = session.getSnapshot();
      if (
        snapshot.status !== "synced" ||
        snapshot.schemaFence ||
        !(await session.hasInitializedLocalContent())
      )
        return;
      const cached = await this.commitPlan(key, (record) =>
        recordAcquiredResourceContent({
          record,
          projectId,
          documentId,
          databaseName,
          schema: collabSchemaKeyTag(),
          generation,
          transitionId: crypto.randomUUID(),
        }),
      );
      if (cached === "unchanged") return;
      this.schedule(key);
      await this.installProjectRegistryOwnership(projectId, key, generation, session);
    } finally {
      if (this.serverSessionCaptures.get(captureId) === captureTail)
        this.serverSessionCaptures.delete(captureId);
      finishCapture();
    }
  }

  private async installProjectRegistryOwnership(
    projectId: string,
    key: ResourceKey,
    generation: string,
    session: DocumentSession,
  ): Promise<void> {
    const databaseName = session.persistenceName;
    if (!databaseName) throw new Error("Registry session has no exact persistence");
    const lease = await this.runtime.registry.admit(projectId, session.documentId, generation);
    const owner = `resource-acquisition:${key.handle}:${crypto.randomUUID()}`;
    this.runtime.registry.retain(owner, [lease]);
    const retained = this.runtime.registry.get(lease);
    if (retained !== session || retained.persistenceName !== databaseName) {
      this.runtime.registry.release(owner);
      throw new Error("Resource ownership did not retain the opened server session");
    }
    let released = false;
    const ownership = {
      lease,
      persistenceGeneration: generation,
      exactDatabaseName: databaseName,
      release: () => {
        if (released) return;
        released = true;
        this.runtime.registry.release(owner);
      },
    };
    try {
      await this.content.adoptRegistrySession(projectId, key, session, ownership);
    } catch (error) {
      ownership.release();
      throw error;
    }
  }

  readProjection(projectId: string): Promise<ResourceProjectionSnapshot> {
    return this.metadata.readProjection(projectId);
  }

  observeProjection(
    projectId: string,
    listener: (snapshot: ResourceProjectionSnapshot) => void,
    onError: (error: unknown) => void,
  ): () => void {
    this.requireOpen();
    let stream = this.projectionStreams.get(projectId);
    if (!stream) {
      const listeners = new Map<
        (snapshot: ResourceProjectionSnapshot) => void,
        (error: unknown) => void
      >();
      const created = {
        listeners,
        snapshot: null as ResourceProjectionSnapshot | null,
        stop: (() => undefined) as () => void,
      };
      created.stop = this.metadata.observeProjection(
        projectId,
        (snapshot) => {
          created.snapshot = snapshot;
          for (const subscriber of created.listeners.keys()) subscriber(snapshot);
        },
        (error) => {
          for (const report of created.listeners.values()) report(error);
        },
      );
      stream = created;
      this.projectionStreams.set(projectId, stream);
    }
    stream.listeners.set(listener, onError);
    const initial = stream.snapshot;
    if (initial)
      queueMicrotask(() => {
        if (this.projectionStreams.get(projectId)?.listeners.has(listener)) listener(initial);
      });
    return () => {
      const current = this.projectionStreams.get(projectId);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      current.stop();
      this.projectionStreams.delete(projectId);
    };
  }

  acquireCatalog(projectId: string, scope: CatalogScope) {
    return this.catalogs.acquire(projectId, scope);
  }

  hintCatalog(projectId: string, scope: CatalogScope, headRevision: string) {
    return this.catalogs.hint(projectId, scope, headRevision);
  }

  async setLocation(
    projectId: string,
    key: ResourceKey,
    destination: Omit<ResourceLocation, "path"> & { folderPath: string },
  ): Promise<{ isLatest: boolean }> {
    return this.locationOperations.run(key, async () => {
      await this.commitPlan(key, (record) =>
        planResourceLocation({
          record,
          projectId,
          intentId: crypto.randomUUID(),
          eligibleAt: Date.now(),
          destination,
        }),
      );
      this.schedule(key);
    });
  }

  async deleteDocument(projectId: string, key: ResourceKey): Promise<void> {
    await this.commitPlan(key, (record) =>
      planResourceDeletion(record, projectId, crypto.randomUUID()),
    );
    this.schedule(key);
  }

  private async commitPlan(
    key: ResourceKey,
    plan: (
      record: ResourceRecord,
    ) => { expectedRevision: number | null; next: ResourceRecord } | null,
  ): Promise<"committed" | "unchanged"> {
    this.requireOpen();
    for (;;) {
      const current = await this.metadata.readResource(key);
      if (!current) throw new Error("Resource is unavailable");
      const write = plan(current);
      if (!write) return "unchanged";
      if ((await this.metadata.commitResource(write)) === "committed") return "committed";
    }
  }

  /** Terminal continuation may finish after the account close fence was raised. */
  private async commitClosingPlan(
    key: ResourceKey,
    plan: (
      record: ResourceRecord,
    ) => { expectedRevision: number | null; next: ResourceRecord } | null,
  ): Promise<void> {
    for (;;) {
      const current = await this.metadata.readResource(key);
      if (!current) throw new Error("Resource is unavailable");
      const write = plan(current);
      if (!write || (await this.metadata.commitResource(write)) === "committed") return;
    }
  }

  private reconcileProjectionRecords(records: readonly ResourceRecord[]): void {
    for (const record of records) {
      const { handle, revision } = record.resource;
      if (this.observedResourceRevisions.get(handle) === revision) continue;
      this.observedResourceRevisions.set(handle, revision);
      this.content.reconcileMetadata(record);
      this.schedule(record.resource);
    }
  }

  private schedule(key: ResourceKey): void {
    if (this.closing) return;
    const id = encodeURIComponent(key.handle);
    if (this.runners.has(id)) {
      this.reruns.set(id, key);
      return;
    }
    const runner = this.run(key)
      .catch(() => undefined)
      .finally(() => {
        if (this.runners.get(id) !== runner) return;
        this.runners.delete(id);
        const rerun = this.reruns.get(id);
        this.reruns.delete(id);
        if (rerun) this.schedule(rerun);
      });
    this.runners.set(id, runner);
  }

  private async run(key: ResourceKey): Promise<void> {
    for (let step = 0; step < 100 && !this.closing; step += 1) {
      const namespace = await reconcileResourceNamespace({
        key,
        metadata: this.metadata,
        transport: this.namespace,
        lock: this.lock,
        newAttemptIds: () => ({ attemptId: crypto.randomUUID(), operationId: crypto.randomUUID() }),
      });
      if (namespace === "needs-repair" && (await this.remintCreateConflict(key))) continue;
      await this.waitForServerSessionCaptures(encodeURIComponent(key.handle));
      const adoption = await this.adoption.reconcile(key);
      const cleanup = await this.reconcileLocalCleanup(key);
      if (namespace !== "progressed" && adoption !== "adopted" && !cleanup) return;
    }
  }

  private async reconcileLocalCleanup(key: ResourceKey): Promise<boolean> {
    const result = await this.lock.run(key, async () => {
      const record = await this.metadata.readResource(key);
      const cleanup = record?.resource.obligations.cleanup;
      const deletion = record?.intents.find(
        (intent) =>
          intent.desired.kind === "delete" &&
          intent.state === "settled-locally" &&
          intent.intentId === cleanup?.obligationId,
      );
      if (!record || !cleanup || !deletion) return false;
      await this.content.clearExactContent({
        projectId: deletion.projectId,
        key,
        documentId: record.resource.identity.documentId,
        databaseName: cleanup.exactDatabaseName,
      });
      await this.commitPlan(key, (current) =>
        acknowledgeLocalResourceCleanup({
          record: current,
          transitionId: deletion.intentId,
          exactDatabaseName: cleanup.exactDatabaseName,
        }),
      );
      return true;
    });
    return result.kind === "acquired" && result.value;
  }

  private async remintCreateConflict(key: ResourceKey): Promise<boolean> {
    const current = await this.metadata.readResource(key);
    if (!current) return false;
    const nextDocumentId = crypto.randomUUID();
    const rebasedIntentIds = Object.fromEntries(
      current.intents
        .filter(
          (intent) =>
            intent.state === "pending" &&
            intent.attempts.length === 0 &&
            intent.identityRevision === current.resource.identity.revision,
        )
        .map((intent) => [intent.intentId, crypto.randomUUID()]),
    );
    const write = remintCreateConflict({
      record: current,
      documentId: nextDocumentId,
      retryIntentId: crypto.randomUUID(),
      rebasedIntentIds,
    });
    if (!write) return false;
    const prepared = this.content.prepareReidentity(
      key,
      current.resource.identity.documentId,
      nextDocumentId,
      write.next.resource.identity.revision,
    );
    const committed = await this.metadata.commitResource(write);
    if (committed === "stale") {
      prepared?.abort();
      const winner = await this.metadata.readResource(key);
      if (winner) this.content.reconcileMetadata(winner);
      return true;
    }
    prepared?.commit();
    return true;
  }

  private async continueTerminal(
    input: TerminalLineageReceipt,
    run: (operation: LocalLineageTerminalOperation) => Promise<void>,
  ): Promise<"completed" | "owned-elsewhere"> {
    const key = { handle: input.lineageHandle };
    const locked = await this.lock.run(key, async () => {
      const known = await this.metadata.readResource(key);
      if (!known) {
        await run({ publish: async () => undefined, acknowledge: async () => undefined });
        return;
      }
      await run({
        publish: async () => {
          await this.commitClosingPlan(key, (record) =>
            publishResourceTerminal({ record, ...input }),
          );
          this.adoption.cancel(key);
        },
        acknowledge: () =>
          this.commitClosingPlan(key, (record) =>
            acknowledgeResourceTerminalCleanup({ record, ...input }),
          ),
      });
    });
    return locked.kind === "acquired" ? "completed" : "owned-elsewhere";
  }

  private async waitForServerSessionCaptures(id: string): Promise<void> {
    for (;;) {
      const capture = this.serverSessionCaptures.get(id);
      if (!capture) return;
      await capture;
    }
  }

  private requireOpen(): void {
    if (this.closing) throw new Error("Resource replica is closing");
  }

  beginClose(): void {
    if (this.closing) return;
    this.closing = true;
    if (this.started) {
      window.removeEventListener("focus", this.retryAll);
      window.removeEventListener("online", this.retryAll);
      if (this.retryTimer !== null) window.clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.stopReconciliation?.();
    this.stopReconciliation = null;
    this.adoption.beginClose();
    this.catalogs.beginClose();
    this.content.beginClose();
    for (const stream of this.projectionStreams.values()) stream.stop();
    this.projectionStreams.clear();
  }

  async finishClose(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([
      this.adoption.finishClose(),
      this.catalogs.finishClose(),
      ...this.runners.values(),
      ...this.serverSessionCaptures.values(),
    ]);
    await this.content.finishClose();
    this.metadata.beginClose();
    await this.metadata.finishClose();
    this.lockLifetime.abort(new Error("Resource replica is closed"));
  }
}
