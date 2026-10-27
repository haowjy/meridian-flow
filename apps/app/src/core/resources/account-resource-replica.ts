/** Sole browser account owner for durable resource metadata, content, catalogs, and namespace work. */
import type {
  CatalogScope,
  ContextSiblingPosition,
  CopyContextEntryView,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import {
  acknowledgeResourceTerminalCleanup,
  type CopyRoot,
  capturePlacementAdmission,
  copyScopeKeys,
  deleteNeedsServer,
  type FolderNamespaceRecord,
  type FolderNamespaceWrite,
  installedFolderObservation,
  markResourceCreateEligible,
  ownerOf,
  type ParentRef,
  type PlacementAdmission,
  type PlacementSpec,
  planCachedSessionAdoption,
  planCopy,
  planFolderCreate,
  planFolderDeletion,
  planFolderLocalDeletionUndo,
  planFolderLocation,
  planLocalDeletionUndo,
  planResourceDeletion,
  planResourceLocation,
  publishResourceTerminal,
  ResourceCatalogAcquisition,
  type ResourceDestination,
  type ResourceKey,
  type ResourceLocation,
  type ResourcePlacement,
  type ResourceProjectionSnapshot,
  type ResourceRecord,
  recordAcquiredResourceContent,
  reserveResourceDocument,
  resolveRefusedCopy,
  resourcePlacementForSnapshot,
  resourceVisibleInProject,
  sameOwner,
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
import type { ConnectivityHintsPort } from "@/core/transport/connectivity-hints";
import { AccountResourceReconciler } from "./account-resource-reconciler";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import { createResourceCatalogTransport } from "./resource-catalog-transport";
import type { ResourceContentOpenResult } from "./resource-content-access";
import { ResourceContentAccess } from "./resource-content-access";
import { type ResourceIdentityChange, ResourceIdentityFeed } from "./resource-identity-feed";
import { createResourceNamespaceLock } from "./resource-namespace-lock";
import { createResourceNamespaceTransport } from "./resource-namespace-transport";
import { ResourceSessionAdoptionCoordinator } from "./resource-session-adoption";

function exactPersistenceName(accountId: string, persistenceId: string): string {
  return `meridian:resource:${collabSchemaKeyTag()}:${encodeURIComponent(accountId)}:${encodeURIComponent(persistenceId)}`;
}

type OrderedLocationOperation = { generation: number; tail: Promise<void> };

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
  private readonly reconciler: AccountResourceReconciler;
  private readonly identities = new ResourceIdentityFeed();
  private readonly projectionStreams = new Map<
    string,
    {
      listeners: Map<(snapshot: ResourceProjectionSnapshot) => void, (error: unknown) => void>;
      stop: () => void;
      snapshot: ResourceProjectionSnapshot | null;
      error: unknown | null;
    }
  >();
  private readonly serverSessionCaptures = new Map<string, Promise<void>>();
  private readonly exclusiveTails = new Map<string, Promise<void>>();
  private readonly locks = nativeLocks();
  private readonly locationOperations = new ResourceLocationOperationQueue();
  private started = false;
  private stopReconciliation: (() => void) | null = null;
  private closing = false;

  constructor(
    readonly accountId: string,
    private readonly runtime: AccountDocumentSessionRuntime,
    onInvalidated: (error: Error) => void = () => undefined,
    private readonly connectivityHints?: ConnectivityHintsPort,
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
    this.reconciler = new AccountResourceReconciler({
      metadata: this.metadata,
      content: this.content,
      adoption: this.adoption,
      namespace: this.namespace,
      lock: this.lock,
      commitPlan: (key, plan) => this.commitPlan(key, plan),
      capturesSettled: (handle) => this.waitForServerSessionCaptures(encodeURIComponent(handle)),
      isClosing: () => this.closing,
    });
    this.terminal = {
      continueTerminal: (input, run) => this.continueTerminal(input, run),
    };
  }

  /** One section at a time per name: across browser contexts where Web Locks exist, else in this one. */
  private async exclusive<T>(name: string, run: () => Promise<T>): Promise<T> {
    if (this.locks)
      return this.locks.request(
        `meridian:resource:v2:${name}`,
        { mode: "exclusive", signal: this.lockLifetime.signal },
        async (lock) => {
          if (!lock) throw new Error("Resource exclusive lock is unavailable");
          this.requireOpen();
          return run();
        },
      );
    const before = this.exclusiveTails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.exclusiveTails.set(name, turn);
    await before;
    try {
      return await run();
    } finally {
      release();
      if (this.exclusiveTails.get(name) === turn) this.exclusiveTails.delete(name);
    }
  }

  /**
   * Admit a placement behind everything it conflicts with, atomically across this account's
   * browser contexts: the snapshot that fixes its order and predecessors is read, and the intent
   * committed, inside one lock. Two tabs therefore never assign contradictory local order.
   */
  private admitPlacement<T>(
    projectId: string,
    subject: ResourceKey | null,
    describe: (view: {
      snapshot: ResourceProjectionSnapshot;
      placement: ResourcePlacement;
    }) => PlacementSpec,
    commit: (admission: PlacementAdmission) => Promise<T>,
  ): Promise<T> {
    this.requireOpen();
    return this.exclusive(`placement-admission/${encodeURIComponent(this.accountId)}`, async () => {
      const { highWater, ...snapshot } = await this.metadata.readPlacementAdmissionView(
        projectId,
        subject ?? undefined,
      );
      const placement = resourcePlacementForSnapshot(projectId, snapshot);
      return commit(
        capturePlacementAdmission({
          snapshot,
          highWater,
          placement,
          spec: describe({ snapshot, placement }),
        }),
      );
    });
  }

  /**
   * Reserve a document under a client-minted id. `destination` is where the writer put it (the
   * sidebar's New file, a link's Create): it goes out with the create so the server can join a
   * branch's new document waiting there, and the replica shows it there at once. Without one the
   * create is nameless.
   */
  async reserveDocument(
    projectId: string,
    folderPath = "",
    destination?: ResourceDestination,
  ): Promise<{
    key: ResourceKey;
    name: string;
    content: ResourceContentOpenResult;
  }> {
    this.requireOpen();
    return this.exclusive(
      `reservation/${encodeURIComponent(this.accountId)}/${encodeURIComponent(projectId)}`,
      () => this.reserveDocumentSerial(projectId, folderPath, destination),
    );
  }

  private async reserveDocumentSerial(
    projectId: string,
    folderPath: string,
    destination?: ResourceDestination,
  ): Promise<{
    key: ResourceKey;
    name: string;
    content: ResourceContentOpenResult;
  }> {
    const key = { handle: crypto.randomUUID() };
    const documentId = crypto.randomUUID();
    const projection = await this.metadata.readProjection(projectId);
    const placement = resourcePlacementForSnapshot(projectId, projection);
    const names = new Set(
      projection.records.flatMap((record) => {
        if (!resourceVisibleInProject(projectId, record, projection.catalogs)) return [];
        const name = placement.resourceLocation(record)?.name;
        return name ? [name] : [];
      }),
    );
    let ordinal = 1;
    let name = "Untitled";
    while (names.has(name)) {
      ordinal += 1;
      name = `Untitled ${ordinal}`;
    }
    const reserve = (admission?: PlacementAdmission) =>
      reserveResourceDocument({
        projectId,
        handle: key.handle,
        documentId,
        databaseName: exactPersistenceName(this.accountId, crypto.randomUUID()),
        schema: collabSchemaKeyTag(),
        intentId: crypto.randomUUID(),
        ...(admission ? { admission } : {}),
        folderPath,
        provisionalName: destination?.name ?? name,
        ...(destination ? { destination: { value: destination, eligibleAt: Date.now() } } : {}),
      });
    const committed = destination
      ? await this.admitPlacement(
          projectId,
          null,
          () => ({
            projectId,
            subject: documentId,
            source: null,
            destination: destination.parent,
            position: destination.position,
          }),
          async (admission) => this.metadata.commitResource(reserve(admission)),
        )
      : await this.metadata.commitResource(reserve());
    if (committed !== "committed") throw new Error("Resource identity reservation collided");
    const content = await this.content.open(projectId, key, `reservation:${key.handle}`);
    return { key, name: destination?.name ?? name, content };
  }

  start(): void {
    this.requireOpen();
    if (this.started) return;
    this.started = true;
    this.reconciler.start(this.connectivityHints);
    // Reconciliation belongs to the account lifetime, not mounted catalog consumers.
    this.stopReconciliation = this.metadata.observeProjection(
      "",
      ({ records, folders, operations }) => {
        if (this.closing) return;
        this.identities.observe(records);
        this.reconciler.reconcileProjection(records, folders, operations);
      },
      () => undefined,
    );
  }

  async markCreateEligible(key: ResourceKey): Promise<void> {
    this.requireOpen();
    await this.commitPlan(key, (record) => markResourceCreateEligible(record, Date.now()));
    this.reconciler.schedule(key);
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
      this.reconciler.schedule(key);
    }
    const runner = this.reconciler.runnerFor(key);
    if (runner) await runner;
    if (this.closing) return;
    ownership = this.content.ownershipFor(key, projectId);
    if (ownership !== "registry-other") return;
    const resolved = await lookupProjectContextAvailability(projectId, [session.documentId]);
    const available = resolved.resolutions[0];
    if (available?.kind !== "available" || available.documentId !== session.documentId) return;
    const incarnation = this.runtime.liveIncarnation.incarnationOf(session);
    if (!incarnation) return;
    await this.installProjectRegistryOwnership(
      projectId,
      key,
      available.generation,
      incarnation,
      session,
    );
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

  /** The folder record an id names, the id it was minted under included (`folderForId`). */
  readKnownFolder(folderId: string): Promise<FolderNamespaceRecord | null> {
    return this.metadata.readFolderById(folderId);
  }

  async canAcquireRemoteDocument(projectId: string, documentId: string): Promise<boolean> {
    const known = await this.readKnownDocument(projectId, documentId);
    return Boolean(
      known &&
        known.record.resource.lifecycle.kind === "acknowledged" &&
        resourcePlacementForSnapshot(
          projectId,
          await this.readProjection(projectId),
        ).resourceLocation(known.record),
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
    // The cache belongs to the room's incarnation, which can be older than `generation`.
    const incarnation = this.runtime.liveIncarnation.incarnationOf(session);
    if (!incarnation) return;
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
      await this.commitPlan(key, (record) =>
        recordAcquiredResourceContent({
          record,
          projectId,
          documentId,
          databaseName,
          schema: collabSchemaKeyTag(),
          generation: incarnation,
          transitionId: crypto.randomUUID(),
        }),
      );
      const captured = await this.metadata.readAccessibleResource(projectId, key);
      if (
        !captured ||
        captured.resource.identity.documentId !== documentId ||
        captured.resource.lifecycle.kind !== "acknowledged" ||
        captured.resource.lifecycle.availabilityGeneration !== incarnation ||
        captured.resource.content.kind !== "exact" ||
        captured.resource.content.databaseName !== databaseName
      )
        return;
      this.reconciler.schedule(key);
      await this.installProjectRegistryOwnership(projectId, key, generation, incarnation, session);
    } finally {
      if (this.serverSessionCaptures.get(captureId) === captureTail)
        this.serverSessionCaptures.delete(captureId);
      finishCapture();
    }
  }

  private async installProjectRegistryOwnership(
    projectId: string,
    key: ResourceKey,
    admission: string,
    incarnation: string,
    session: DocumentSession,
  ): Promise<void> {
    const databaseName = session.persistenceName;
    if (!databaseName) throw new Error("Registry session has no exact persistence");
    const lease = await this.runtime.registry.admit(projectId, session.documentId, admission);
    const owner = `resource-acquisition:${key.handle}:${crypto.randomUUID()}`;
    this.runtime.registry.retain(owner, [lease]);
    const retained = this.runtime.registry.get(lease);
    if (
      retained !== session ||
      retained.persistenceName !== databaseName ||
      this.runtime.liveIncarnation.incarnationOf(retained) !== incarnation
    ) {
      this.runtime.registry.release(owner);
      throw new Error("Resource ownership did not retain the opened server session");
    }
    let released = false;
    const ownership = {
      lease,
      persistenceGeneration: incarnation,
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

  readProjectionState(
    projectId: string,
  ):
    | { kind: "pending" }
    | { kind: "ready"; snapshot: ResourceProjectionSnapshot }
    | { kind: "failed"; error: unknown } {
    const stream = this.projectionStreams.get(projectId);
    if (stream?.error !== null && stream?.error !== undefined)
      return { kind: "failed", error: stream.error };
    if (stream?.snapshot) return { kind: "ready", snapshot: stream.snapshot };
    return { kind: "pending" };
  }

  whenProjectionReady(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ResourceProjectionSnapshot> {
    const state = this.readProjectionState(projectId);
    if (state.kind === "ready") return Promise.resolve(state.snapshot);
    if (state.kind === "failed") return Promise.reject(state.error);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const stop = this.observeProjection(projectId, settle, fail);
      const abort = () => fail(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      function cleanup() {
        signal?.removeEventListener("abort", abort);
        stop();
      }
      function settle(snapshot: ResourceProjectionSnapshot) {
        cleanup();
        resolve(snapshot);
      }
      function fail(error: unknown) {
        cleanup();
        reject(error);
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
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
        error: null as unknown | null,
        stop: (() => undefined) as () => void,
      };
      created.stop = this.metadata.observeProjection(
        projectId,
        (snapshot) => {
          created.snapshot = snapshot;
          created.error = null;
          for (const subscriber of created.listeners.keys()) subscriber(snapshot);
        },
        (error) => {
          created.error = error;
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

  /** A catalog observation that starts after this call; never joins an older in-flight one. */
  acquireCatalogAfter(projectId: string, scope: CatalogScope) {
    return this.catalogs.acquireAfter(projectId, scope);
  }

  hintCatalog(projectId: string, scope: CatalogScope, headRevision: string) {
    return this.catalogs.hint(projectId, scope, headRevision);
  }

  /** Capture a displayed row's identity before admitting a command. Never persist a path edge. */
  async findParentAtLocation(
    projectId: string,
    location: ResourceLocation,
  ): Promise<ParentRef | null> {
    if (!location.path || location.path === "/")
      return { kind: "root", scheme: location.scheme, owner: ownerOf(location) };
    const snapshot = await this.readProjection(projectId);
    const placement = resourcePlacementForSnapshot(projectId, snapshot);
    // A folder only this device holds yet is a parent like any other.
    const folderIds = [
      ...snapshot.catalogs
        .flatMap((catalog) => catalog.entries)
        .flatMap((entry) =>
          entry.kind === "folder" && !entry.navigationOnly ? [entry.entryId] : [],
        ),
      ...snapshot.folders.map((folder) => folder.folderId),
    ];
    for (const folderId of folderIds) {
      const home = placement.folderLocation(folderId);
      if (
        home &&
        home.scheme === location.scheme &&
        sameOwner(home, location) &&
        home.path === location.path
      )
        return { kind: "folder", folderId };
    }
    return null;
  }

  async parentForEntry(projectId: string, entryId: string): Promise<ParentRef> {
    const snapshot = await this.readProjection(projectId);
    const placement = resourcePlacementForSnapshot(projectId, snapshot);
    // A row can still carry a create's client ID after the server's ID replaced it.
    const record = snapshot.records.find(
      (r) => r.resource.identity.documentId === entryId || entryId in r.resource.aliases,
    );
    const parent = record
      ? placement.parentForResource(record)
      : placement.parentForFolder(entryId);
    if (!parent) throw new Error("Entry parent is unavailable");
    return parent;
  }

  /** `operationId` names the move's receipt; absent when nothing changed. */
  async setLocation(
    projectId: string,
    key: ResourceKey,
    destination: ResourceDestination,
    typedName?: string,
  ): Promise<{ isLatest: boolean; operationId?: string }> {
    const operationId = crypto.randomUUID();
    let admitted = false;
    const { isLatest } = await this.locationOperations.run(key, async () => {
      admitted =
        (await this.admitPlacement(
          projectId,
          key,
          ({ snapshot, placement }) => {
            const record = snapshot.records.find((r) => r.resource.handle === key.handle);
            return {
              projectId,
              subject: record?.resource.identity.documentId ?? key.handle,
              source: record ? placement.parentForResource(record) : null,
              destination: destination.parent,
              position: destination.position,
            };
          },
          (admission) =>
            this.commitPlan(key, (record) =>
              planResourceLocation({
                record,
                projectId,
                intentId: crypto.randomUUID(),
                operationId,
                eligibleAt: Date.now(),
                admission,
                destination,
                typedName,
              }),
            ),
        )) === "committed";
      this.reconciler.schedule(key);
    });
    return { isLatest, ...(admitted ? { operationId } : {}) };
  }

  /**
   * Copy entries into one destination. The roots are listed there at once under their predicted
   * names (`overlayCopyRoots`); the server's answer places them, or a refusal removes them. A
   * document the device holds open sends its state vector, so the copy waits for edits the server
   * has not received. `view` is what the copy reads: the live document, or the draft a tab shows.
   */
  async copyEntries(
    projectId: string,
    input: {
      sources: readonly {
        kind: "file" | "folder";
        id: string;
        predictedName: string;
        view?: CopyContextEntryView;
        /** A draft tab's room vector; a live document's comes from its open session. */
        stateVector?: string;
      }[];
      /** The destination's scheme: an account-owned `user` folder belongs to no project. */
      scheme: ProjectContextTreeScheme;
      destination: { parent: ParentRef; position?: ContextSiblingPosition };
      /** Where the writer started it; a refusal shows there when the destination is gone. */
      origin?: string;
    },
  ): Promise<{ operationId: string; roots: readonly CopyRoot[] }> {
    this.requireOpen();
    const operationId = crypto.randomUUID();
    const roots = await Promise.all(
      input.sources.map(async (source) => {
        const view = source.view ?? { kind: "live" as const };
        const known =
          source.kind === "file" ? await this.readKnownDocument(projectId, source.id) : null;
        if (source.kind === "file" && !known) throw new Error("Document is not in the replica");
        const stateVector =
          source.stateVector ??
          (source.kind === "file" && view.kind === "live"
            ? this.content.stateVector(source.id)
            : null);
        return {
          kind: source.kind,
          handle: crypto.randomUUID(),
          copyId: crypto.randomUUID(),
          sourceId: source.id,
          view,
          ...(stateVector ? { stateVector } : {}),
          predictedName: source.predictedName,
          classification: known?.record.resource.classification ?? null,
        };
      }),
    );
    await this.admitPlacement(
      projectId,
      null,
      () => ({
        projectId,
        subject: operationId,
        source: null,
        destination: input.destination.parent,
        position: input.destination.position,
        touches: copyScopeKeys(roots),
      }),
      async (admission) => {
        const committed = await this.metadata.commitOperation(
          planCopy({
            projectId,
            operationId,
            intentId: crypto.randomUUID(),
            admission,
            scheme: input.scheme,
            roots,
            destination: input.destination,
            origin: input.origin,
          }),
        );
        if (committed !== "committed") throw new Error("Copy operation identity collided");
      },
    );
    return { operationId, roots: roots.map(({ classification: _, ...root }) => root) };
  }

  /** The writer is done with a refused Copy: dismissed, or sent again as a new one. */
  async resolveCopyRefusal(operationId: string): Promise<void> {
    this.requireOpen();
    for (;;) {
      const current = await this.metadata.readOperation(operationId);
      const write = current && resolveRefusedCopy(current);
      if (!write) return;
      if ((await this.metadata.commitOperation(write)) === "committed") return;
    }
  }

  /**
   * Create a folder under an id this device mints. The writer sees it at once and can place
   * documents and folders in it; the server's answer arrives in the background, and a refusal
   * stays on the folder.
   */
  async createFolder(
    projectId: string,
    scheme: ProjectContextTreeScheme,
    destination: ResourceDestination,
  ): Promise<{ folderId: string }> {
    this.requireOpen();
    const folderId = crypto.randomUUID();
    // A handle names the record, never the id: a remint changes the id and keeps the handle.
    const key: ResourceKey = { handle: crypto.randomUUID() };
    await this.admitPlacement(
      projectId,
      null,
      () => ({
        projectId,
        subject: folderId,
        source: null,
        destination: destination.parent,
        position: destination.position,
      }),
      async (admission) => {
        const committed = await this.metadata.commitFolder(
          planFolderCreate({
            projectId,
            scheme,
            handle: key.handle,
            folderId,
            intentId: crypto.randomUUID(),
            admission,
            destination,
          }),
        );
        if (committed !== "committed") throw new Error("Folder identity reservation collided");
      },
    );
    this.reconciler.scheduleFolder(key);
    return { folderId };
  }

  /**
   * Admit a folder rename or move locally. The source is the installed catalog's location,
   * never the optimistic projection, so a pending parent move cannot leak into the request.
   */
  async setFolderLocation(
    projectId: string,
    folderId: string,
    destination: ResourceDestination,
    typedName?: string,
  ): Promise<{ operationId?: string }> {
    return this.commitFolderPlan(projectId, folderId, destination, (input) =>
      planFolderLocation({ ...input, destination, typedName }),
    );
  }

  async deleteFolder(projectId: string, folderId: string): Promise<{ operationId?: string }> {
    const result = await this.commitFolderPlan(projectId, folderId, null, planFolderDeletion);
    // A folder only this device held settles its delete here; its pending children go with it
    // and the same Undo window brings the subtree back.
    if (result.operationId)
      await this.settleLocalFolderChildren(projectId, folderId, result.operationId);
    return result;
  }

  private commitFolderPlan(
    projectId: string,
    folderId: string,
    destination: ResourceDestination | null,
    plan: (input: Parameters<typeof planFolderDeletion>[0]) => FolderNamespaceWrite | null,
  ): Promise<{ operationId?: string }> {
    this.requireOpen();
    return this.admitPlacement(
      projectId,
      null,
      ({ placement }) => ({
        projectId,
        subject: folderId,
        source: placement.parentForFolder(folderId),
        destination: destination?.parent ?? null,
        position: destination?.position,
      }),
      (admission) => this.commitFolderPlanAdmitted(projectId, folderId, admission, plan),
    );
  }

  private async commitFolderPlanAdmitted(
    projectId: string,
    folderId: string,
    admission: PlacementAdmission,
    plan: (input: Parameters<typeof planFolderDeletion>[0]) => FolderNamespaceWrite | null,
  ): Promise<{ operationId?: string }> {
    const operationId = crypto.randomUUID();
    for (;;) {
      const [current, projection] = await Promise.all([
        this.metadata.readFolderById(folderId),
        this.metadata.readProjection(projectId),
      ]);
      // The id the writer acted on may be a former one: the record keeps its handle through a remint.
      if (!current) throw new Error("Folder is unavailable");
      const key: ResourceKey = { handle: current.handle };
      const observation = installedFolderObservation(
        projection.catalogs,
        projectId,
        current.folderId,
      );
      // A folder only this device holds has no place yet, until a catalog lists it.
      const source = current.canonical ?? observation?.location;
      const write = plan({
        record: current,
        projectId,
        handle: key.handle,
        folderId: current.folderId,
        source,
        sourceParent: current.canonicalParent ?? observation?.parent,
        sourceObservationVersion: current.observationVersion ?? observation?.observationVersion,
        intentId: crypto.randomUUID(),
        operationId,
        admission,
      });
      if (!write) return {};
      if ((await this.metadata.commitFolder(write)) !== "committed") continue;
      this.reconciler.scheduleFolder(key);
      return { operationId };
    }
  }

  /**
   * A local folder delete is one operation over its local subtree: every never-accepted folder
   * and document under it settles its own delete under the same operation, so its pending
   * creates stop and one Undo restores them all. Server-held descendants keep their own
   * lifecycle and are not deleted by their local parent.
   */
  private async settleLocalFolderChildren(
    projectId: string,
    folderId: string,
    operationId: string,
  ): Promise<void> {
    const root = await this.metadata.readFolderById(folderId);
    const local = root?.intents.some(
      (intent) =>
        intent.operationId === operationId &&
        intent.desired.kind === "delete" &&
        intent.state === "settled-locally",
    );
    if (!local) return;
    const projection = await this.metadata.readProjection(projectId);
    const placement = resourcePlacementForSnapshot(projectId, projection);
    const descendants = new Map<string, FolderNamespaceRecord>();
    for (let added = true; added; ) {
      added = false;
      for (const folder of projection.folders) {
        if (descendants.has(folder.folderId)) continue;
        const parent = placement.parentForFolder(folder.folderId);
        if (
          parent?.kind === "folder" &&
          (parent.folderId === root?.folderId || descendants.has(parent.folderId))
        ) {
          descendants.set(folder.folderId, folder);
          added = true;
        }
      }
    }
    for (const folder of descendants.values())
      await this.settleLocalFolderDeletion(projectId, folder, operationId);
    for (const record of projection.records) {
      const parent = placement.parentForResource(record);
      if (
        parent?.kind === "folder" &&
        (parent.folderId === root?.folderId || descendants.has(parent.folderId))
      )
        await this.settleLocalDocumentDeletion(projectId, record.resource.handle, operationId);
    }
  }

  private async settleLocalFolderDeletion(
    projectId: string,
    folder: FolderNamespaceRecord,
    operationId: string,
  ): Promise<boolean> {
    const key: ResourceKey = { handle: folder.handle };
    return this.withResourceLock(key, async () => {
      for (;;) {
        const current = await this.metadata.readFolder(key);
        if (!current || deleteNeedsServer(current.serverHold)) return false;
        const write = planFolderDeletion({
          record: current,
          projectId,
          handle: key.handle,
          folderId: current.folderId,
          intentId: crypto.randomUUID(),
          operationId,
        });
        if (!write?.next.localDeletion) return false;
        if ((await this.metadata.commitFolder(write)) === "committed") {
          this.reconciler.scheduleFolder(key);
          return true;
        }
      }
    });
  }

  private async settleLocalDocumentDeletion(
    projectId: string,
    handle: string,
    operationId: string,
  ): Promise<boolean> {
    const key: ResourceKey = { handle };
    return this.withResourceLock(key, async () => {
      for (;;) {
        const current = await this.metadata.readResource(key);
        if (!current || deleteNeedsServer(current.resource.serverHold)) return false;
        const write = planResourceDeletion(current, projectId, crypto.randomUUID(), operationId);
        const settled = write?.next.intents.some(
          (intent) =>
            intent.operationId === operationId &&
            intent.desired.kind === "delete" &&
            intent.state === "settled-locally",
        );
        if (!write || !settled) return false;
        if ((await this.metadata.commitResource(write)) === "committed") {
          this.reconciler.schedule(key);
          return true;
        }
      }
    });
  }

  private async withResourceLock(
    key: ResourceKey,
    commit: () => Promise<boolean>,
  ): Promise<boolean> {
    for (let busy = 0; busy < 20; busy += 1) {
      const result = await this.lock.run(key, commit);
      if (result.kind === "acquired") return result.value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  async deleteDocument(projectId: string, key: ResourceKey): Promise<{ operationId?: string }> {
    const operationId = crypto.randomUUID();
    let planned = false;
    const admitted = await this.admitPlacement(
      projectId,
      key,
      ({ snapshot, placement }) => {
        const record = snapshot.records.find((r) => r.resource.handle === key.handle);
        return {
          projectId,
          subject: record?.resource.identity.documentId ?? key.handle,
          source: record ? placement.parentForResource(record) : null,
          destination: null,
        };
      },
      (admission) =>
        this.commitPlan(key, (record) => {
          const write = planResourceDeletion(
            record,
            projectId,
            crypto.randomUUID(),
            operationId,
            admission,
          );
          planned = write !== null;
          return write;
        }),
    );
    this.reconciler.schedule(key);
    return admitted === "committed" && planned ? { operationId } : {};
  }

  /**
   * Undo of a local deletion while its window is open: a document comes back with its text, a
   * folder with the children the same operation took down. False once the window has closed or
   * when no such deletion is held. Document content stays under the lock cleanup holds while it
   * clears it, so Undo never revives a document whose text was just cleared.
   */
  async restoreLocalDeletion(projectId: string, operationId: string): Promise<boolean> {
    this.requireOpen();
    const projection = await this.metadata.readProjection(projectId);
    let restored = false;
    for (const folder of projection.folders) {
      if (
        !folder.intents.some(
          (intent) => intent.operationId === operationId && intent.desired.kind === "delete",
        )
      )
        continue;
      if (await this.restoreFolderLocalDeletion(folder.folderId, operationId)) restored = true;
    }
    for (const record of projection.records) {
      if (
        !record.intents.some(
          (intent) => intent.operationId === operationId && intent.desired.kind === "delete",
        )
      )
        continue;
      const key = { handle: record.resource.handle };
      const restoredRecord = await this.withResourceLock(key, async () => {
        let restored = false;
        await this.commitPlan(key, (current) => {
          const write = planLocalDeletionUndo(current, {
            operationId,
            createIntentId: crypto.randomUUID(),
            now: Date.now(),
          });
          restored = write !== null;
          return write;
        });
        return restored;
      });
      if (restoredRecord) {
        this.reconciler.schedule(key);
        restored = true;
      }
    }
    return restored;
  }

  private async restoreFolderLocalDeletion(
    folderId: string,
    operationId: string,
  ): Promise<boolean> {
    const folder = await this.metadata.readFolderById(folderId);
    if (!folder) return false;
    const key: ResourceKey = { handle: folder.handle };
    const restored = await this.withResourceLock(key, async () => {
      for (;;) {
        const current = await this.metadata.readFolder(key);
        if (!current) return false;
        const write = planFolderLocalDeletionUndo(current, {
          operationId,
          createIntentId: crypto.randomUUID(),
          now: Date.now(),
        });
        if (!write) return false;
        if ((await this.metadata.commitFolder(write)) === "committed") return true;
      }
    });
    if (restored) this.reconciler.scheduleFolder(key);
    return restored;
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

  /**
   * A stored document id that now answers to another current id: a join followed (this or
   * another tab, from the answer or the catalog entry) or a create reminted. Live changes only.
   * What the server knows about the document, such as a draft over it, may have been out of
   * reach until now.
   */
  onIdentityChanged(listener: (change: ResourceIdentityChange) => void): () => void {
    return this.identities.subscribe(listener);
  }

  /** Every account projection, current at subscription and again on each change. */
  onProjection(listener: (records: readonly ResourceRecord[]) => void): () => void {
    return this.identities.subscribeProjection(listener);
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
    if (this.started) this.reconciler.beginClose();
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
      ...this.reconciler.pending(),
      ...this.serverSessionCaptures.values(),
    ]);
    await this.content.finishClose();
    this.metadata.beginClose();
    await this.metadata.finishClose();
    this.lockLifetime.abort(new Error("Resource replica is closed"));
  }
}
