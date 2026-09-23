/** Account-owned local content access; exact cache usability is independent from remote admission. */
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import type {
  ResourceKey,
  ResourceMetadataStore,
  ResourceRecord,
} from "@meridian/resource-replica";
import type { DocumentSession } from "@/core/editor/document-session";
import type { LocalDocumentSessionFactory } from "@/core/editor/document-session-registry";
import type {
  LocalDocumentSessionHandoff,
  LocalDocumentSessionReservationPort,
  TransferredDocumentSessionOwnership,
} from "@/core/editor/local-document-session-adoption";

export type ResourceContentUnavailableReason =
  | "missing"
  | "unacquired"
  | "uninitialized"
  | "schema-mismatch"
  | "terminal"
  | "deleted"
  | "changed";

export type ResourceContentHandle = Readonly<{
  key: ResourceKey;
  documentId: string;
  session: DocumentSession;
  release(): void;
}>;

export type ResourceContentOpenResult =
  | { kind: "opened"; handle: ResourceContentHandle }
  | { kind: "cancelled" }
  | { kind: "unavailable"; reason: ResourceContentUnavailableReason };

type ContentIdentity = Readonly<{
  documentId: string;
  identityRevision: number;
  databaseName: string;
}>;

type ContentEntry = {
  identity: ContentIdentity;
  session: DocumentSession;
  leases: Map<symbol, boolean>;
  reidentity?: {
    target: ContentIdentity;
    /** A competing durable remint observed while this local CAS is unresolved. */
    observed?: ResourceRecord;
    commit(): void;
    abort(): void;
  };
  ownership:
    | { kind: "local" }
    | {
        kind: "transferring";
        projectId: string;
        transitionId: string;
        handoff: LocalDocumentSessionHandoff;
        reservations: LocalDocumentSessionReservationPort;
      }
    | {
        kind: "registry";
        ownershipByProject: Map<string, TransferredDocumentSessionOwnership>;
      };
};

type ContentRetirement = {
  session: DocumentSession;
  attempt: Promise<void> | null;
};

export type ResourceContentTransfer = Readonly<{
  projectId: string;
  key: ResourceKey;
  transitionId: string;
  documentId: string;
  identityRevision: number;
  databaseName: string;
}>;

export type ResourceContentTransferResult =
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "reserved"; handoff: LocalDocumentSessionHandoff }>
  | Readonly<{ kind: "adopted"; ownership: TransferredDocumentSessionOwnership }>;

export type ResourceContentReidentity = Readonly<{
  commit(): void;
  abort(): void;
}>;

function resourceKey(key: ResourceKey): string {
  return encodeURIComponent(key.handle);
}

function localDisposition(record: ResourceRecord | null): ResourceContentUnavailableReason | null {
  if (!record) return "missing";
  if (record.intents.some((intent) => intent.state === "settled-locally")) return "deleted";
  if (record.resource.lifecycle.kind === "terminal") return "terminal";
  if (record.resource.content.kind === "unacquired") return "unacquired";
  if (
    record.resource.content.schema !== null &&
    record.resource.content.schema !== collabSchemaKeyTag()
  )
    return "schema-mismatch";
  return null;
}

function identityOf(record: ResourceRecord): ContentIdentity {
  if (record.resource.content.kind !== "exact") throw new Error("Resource content is not exact");
  return {
    documentId: record.resource.identity.documentId,
    identityRevision: record.resource.identity.revision,
    databaseName: record.resource.content.databaseName,
  };
}

function sameIdentity(left: ContentIdentity, record: ResourceRecord): boolean {
  if (record.resource.content.kind !== "exact") return false;
  return (
    left.documentId === record.resource.identity.documentId &&
    left.identityRevision === record.resource.identity.revision &&
    left.databaseName === record.resource.content.databaseName
  );
}

export class ResourceContentAccess {
  private readonly entries = new Map<string, ContentEntry>();
  private readonly openings = new Map<string, Promise<ContentEntry | ResourceContentOpenResult>>();
  private readonly retirements = new Map<string, ContentRetirement>();
  private readonly operations = new Set<Promise<unknown>>();
  private state: "open" | "closing" | "closed" = "open";

  constructor(
    readonly accountId: string,
    private readonly metadata: ResourceMetadataStore,
    private readonly sessions: LocalDocumentSessionFactory,
    private readonly epoch: AbortSignal,
  ) {
    if (metadata.accountId !== accountId) throw new Error("Resource content account mismatch");
  }

  open(
    projectId: string,
    key: ResourceKey,
    participantId: string,
    signal?: AbortSignal,
    options: { adoptionEligible?: boolean } = {},
  ): Promise<ResourceContentOpenResult> {
    if (participantId.length === 0) throw new Error("Resource content participant is required");
    return this.track(
      this.openTracked(projectId, key, participantId, signal, options.adoptionEligible ?? false),
    );
  }

  clearExactContent(input: {
    projectId: string;
    key: ResourceKey;
    documentId: string;
    databaseName: string;
  }): Promise<void> {
    return this.track(this.clearExactContentTracked(input));
  }

  reserveTransfer(
    input: ResourceContentTransfer,
    reservations: LocalDocumentSessionReservationPort,
  ): Promise<ResourceContentTransferResult> {
    return this.track(this.reserveTransferTracked(input, reservations));
  }

  /** Install a session already retained by registry authority after metadata acquisition commits. */
  async adoptRegistrySession(
    projectId: string,
    key: ResourceKey,
    session: DocumentSession,
    ownership: TransferredDocumentSessionOwnership,
  ): Promise<void> {
    const id = resourceKey(key);
    const current = await this.metadata.readAccessibleResource(projectId, key);
    if (!current || localDisposition(current) || current.resource.content.kind !== "exact") {
      ownership.release();
      throw new Error("Acquired resource content is unavailable");
    }
    const identity = identityOf(current);
    if (
      session.documentId !== identity.documentId ||
      session.persistenceName !== identity.databaseName ||
      ownership.exactDatabaseName !== identity.databaseName
    ) {
      ownership.release();
      throw new Error("Acquired registry session does not match resource content");
    }
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.session !== session) {
        ownership.release();
        throw new Error("Resource already owns another session");
      }
      if (existing.ownership.kind !== "registry") {
        ownership.release();
        throw new Error("Resource session has not transferred to registry ownership");
      }
      const prior = existing.ownership.ownershipByProject.get(projectId);
      if (prior) ownership.release();
      else existing.ownership.ownershipByProject.set(projectId, ownership);
      return;
    }
    this.entries.set(id, {
      identity,
      session,
      leases: new Map(),
      ownership: { kind: "registry", ownershipByProject: new Map([[projectId, ownership]]) },
    });
  }

  ownershipFor(
    key: ResourceKey,
    projectId: string,
  ): "local" | "transferring" | "registry" | "registry-other" | null {
    const ownership = this.entries.get(resourceKey(key))?.ownership;
    if (!ownership) return null;
    if (ownership.kind !== "registry") return ownership.kind;
    return ownership.ownershipByProject.has(projectId) ? "registry" : "registry-other";
  }

  /** Prepare an exact detached-session remint around the caller's metadata CAS. */
  prepareReidentity(
    key: ResourceKey,
    currentDocumentId: string,
    nextDocumentId: string,
    nextIdentityRevision: number,
  ): ResourceContentReidentity | null {
    const entry = this.entries.get(resourceKey(key));
    if (!entry) return null;
    if (
      entry.identity.documentId !== currentDocumentId ||
      entry.identity.identityRevision + 1 !== nextIdentityRevision ||
      entry.ownership.kind !== "local"
    ) {
      throw new Error("Resource content cannot be reminted from its current identity");
    }
    if (entry.reidentity) throw new Error("Resource content remint is already prepared");
    const session = entry.session.prepareDetachedReidentity(nextDocumentId);
    let settled = false;
    const pending: NonNullable<ContentEntry["reidentity"]> = {
      target: {
        ...entry.identity,
        documentId: nextDocumentId,
        identityRevision: nextIdentityRevision,
      },
      commit: () => {
        if (settled) return;
        settled = true;
        entry.identity = pending.target;
        session.commit();
        if (entry.reidentity === pending) delete entry.reidentity;
      },
      abort: () => {
        if (settled) return;
        settled = true;
        session.abort();
        if (entry.reidentity === pending) delete entry.reidentity;
        if (pending.observed) this.reconcileMetadata(pending.observed);
      },
    };
    entry.reidentity = pending;
    return pending;
  }

  /** Apply a durable remint observed from another browser context without replacing its Y.Doc. */
  reconcileMetadata(record: ResourceRecord): void {
    const entry = this.entries.get(resourceKey(record.resource));
    if (!entry || sameIdentity(entry.identity, record)) return;
    if (entry.reidentity) {
      if (sameIdentity(entry.reidentity.target, record)) entry.reidentity.commit();
      else if (record.resource.identity.revision > entry.identity.identityRevision)
        entry.reidentity.observed = record;
      return;
    }
    if (
      entry.ownership.kind !== "local" ||
      record.resource.content.kind !== "exact" ||
      entry.identity.databaseName !== record.resource.content.databaseName ||
      record.resource.identity.revision <= entry.identity.identityRevision ||
      !record.resource.aliases[entry.identity.documentId]
    )
      return;
    const session = entry.session.prepareDetachedReidentity(record.resource.identity.documentId);
    entry.identity = identityOf(record);
    session.commit();
  }

  private async reserveTransferTracked(
    input: ResourceContentTransfer,
    reservations: LocalDocumentSessionReservationPort,
  ): Promise<ResourceContentTransferResult> {
    if (this.state !== "open" || this.epoch.aborted)
      throw new Error("Resource content access is closing");
    const id = resourceKey(input.key);
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Resource content must be open before session adoption");
    const current = await this.metadata.readAccessibleResource(input.projectId, input.key);
    if (
      this.state !== "open" ||
      this.epoch.aborted ||
      !current ||
      localDisposition(current) ||
      !sameIdentity(entry.identity, current) ||
      current.resource.identity.documentId !== input.documentId ||
      current.resource.identity.revision !== input.identityRevision ||
      current.resource.content.kind !== "exact" ||
      current.resource.content.databaseName !== input.databaseName ||
      this.entries.get(id) !== entry
    ) {
      throw new Error("Resource content identity changed before session adoption");
    }
    if (entry.ownership.kind === "registry") {
      const ownership = entry.ownership.ownershipByProject.get(input.projectId);
      if (!ownership) throw new Error("Resource content needs authority for this project");
      const { lease } = ownership;
      if (
        lease.documentId !== input.documentId ||
        ownership.exactDatabaseName !== input.databaseName
      ) {
        throw new Error("Resource content is adopted by different authority");
      }
      return { kind: "adopted", ownership };
    }
    if (entry.ownership.kind === "transferring") {
      if (
        entry.ownership.projectId !== input.projectId ||
        entry.ownership.transitionId !== input.transitionId
      ) {
        throw new Error("A different session adoption already owns this resource");
      }
      return { kind: "reserved", handoff: entry.ownership.handoff };
    }
    // Navigation and reconciliation probes cannot keep the transferred editor session alive.
    if (![...entry.leases.values()].some(Boolean)) return { kind: "waiting" };

    const handoff = reservations.reserve({
      projectId: input.projectId,
      documentId: input.documentId,
      session: entry.session,
      ownerRevision: input.identityRevision,
      lineageHandle: input.key.handle,
      exactDatabaseName: input.databaseName,
      prepareCommit: () => {
        if (
          this.entries.get(id) !== entry ||
          entry.identity.documentId !== input.documentId ||
          entry.identity.identityRevision !== input.identityRevision ||
          entry.identity.databaseName !== input.databaseName ||
          entry.ownership.kind !== "transferring" ||
          entry.ownership.transitionId !== input.transitionId
        ) {
          throw new Error("Resource content ownership changed during session adoption");
        }
      },
      completeCommit: (admitted) => {
        if (this.entries.get(id) !== entry)
          throw new Error("Resource content disappeared during session adoption");
        if (
          admitted.lease.projectId !== input.projectId ||
          admitted.lease.documentId !== input.documentId ||
          admitted.exactDatabaseName !== input.databaseName
        ) {
          throw new Error("Session adoption returned different authority");
        }
        entry.ownership = {
          kind: "registry",
          ownershipByProject: new Map([[admitted.lease.projectId, admitted]]),
        };
        if (entry.leases.size === 0) {
          this.entries.delete(id);
          admitted.release();
        }
      },
    });
    entry.ownership = {
      kind: "transferring",
      projectId: input.projectId,
      transitionId: input.transitionId,
      handoff,
      reservations,
    };
    return { kind: "reserved", handoff };
  }

  abortTransfer(key: ResourceKey, handoff: LocalDocumentSessionHandoff): void {
    const id = resourceKey(key);
    const entry = this.entries.get(id);
    if (entry?.ownership.kind !== "transferring" || entry.ownership.handoff !== handoff)
      throw new Error("Resource content handoff is not reserved");
    entry.ownership.reservations.abort(handoff);
    entry.ownership = { kind: "local" };
    if (entry.leases.size === 0) {
      this.entries.delete(id);
      this.retire(id, entry.session);
    }
  }

  private async openTracked(
    projectId: string,
    key: ResourceKey,
    participantId: string,
    signal?: AbortSignal,
    adoptionEligible = false,
  ): Promise<ResourceContentOpenResult> {
    if (this.state !== "open" || this.epoch.aborted || signal?.aborted)
      return { kind: "cancelled" };
    const id = resourceKey(key);
    let entry = this.entries.get(id);
    if (!entry) {
      let opening = this.openings.get(id);
      if (!opening) {
        opening = this.createEntry(projectId, key);
        this.openings.set(id, opening);
        void opening.finally(() => this.openings.delete(id)).catch(() => undefined);
      }
      const result = await opening;
      if ("kind" in result) return result;
      entry = result;
    }
    const lease = Symbol(participantId);
    entry.leases.set(lease, adoptionEligible);
    if (this.state !== "open" || this.epoch.aborted || signal?.aborted) {
      this.releaseLease(id, entry, lease);
      return { kind: "cancelled" };
    }
    let current: ResourceRecord | null;
    try {
      current = await this.metadata.readAccessibleResource(projectId, key);
    } catch (error) {
      this.releaseLease(id, entry, lease);
      throw error;
    }
    const unavailable = localDisposition(current);
    if (current) this.reconcileMetadata(current);
    if (this.state !== "open" || this.epoch.aborted || signal?.aborted) {
      this.releaseLease(id, entry, lease);
      return { kind: "cancelled" };
    }
    if (
      unavailable ||
      !current ||
      !sameIdentity(entry.identity, current) ||
      this.entries.get(id) !== entry ||
      entry.session.getSnapshot().schemaFence !== null
    ) {
      this.releaseLease(id, entry, lease);
      return {
        kind: "unavailable",
        reason:
          unavailable ??
          (entry.session.getSnapshot().schemaFence !== null ? "schema-mismatch" : "changed"),
      };
    }
    let released = false;
    const openedEntry = entry;
    return {
      kind: "opened",
      handle: Object.freeze({
        key: { ...key },
        documentId: openedEntry.identity.documentId,
        session: openedEntry.session,
        release: () => {
          if (released) return;
          released = true;
          this.releaseLease(id, openedEntry, lease);
        },
      }),
    };
  }

  private async createEntry(
    projectId: string,
    key: ResourceKey,
  ): Promise<ContentEntry | ResourceContentOpenResult> {
    const id = resourceKey(key);
    await this.sessions.whenAuthorityReady();
    if (this.state !== "open" || this.epoch.aborted) return { kind: "cancelled" };
    await this.finishRetirement(id);
    if (this.state !== "open" || this.epoch.aborted) return { kind: "cancelled" };
    const record = await this.metadata.readAccessibleResource(projectId, key);
    const unavailable = localDisposition(record);
    if (unavailable || !record) return { kind: "unavailable", reason: unavailable ?? "missing" };
    const content = record.resource.content;
    if (content.kind !== "exact") return { kind: "unavailable", reason: "unacquired" };
    const session = this.sessions.createDetached({
      accountId: this.accountId,
      projectId,
      documentId: record.resource.identity.documentId,
      persistenceKey: content.databaseName,
      fresh: content.initialization === "reserved",
    });
    try {
      await session.whenLocalPersistenceSynced();
      if (this.state !== "open" || this.epoch.aborted) {
        this.retire(id, session);
        return { kind: "cancelled" };
      }
      if (session.getSnapshot().schemaFence !== null) {
        this.retire(id, session);
        return { kind: "unavailable", reason: "schema-mismatch" };
      }
      if (!(await session.hasInitializedLocalContent())) {
        this.retire(id, session);
        return { kind: "unavailable", reason: "uninitialized" };
      }
      if (content.initialization === "reserved")
        await this.acknowledgeInitialization(key, content.databaseName);
      if (this.state !== "open" || this.epoch.aborted) {
        this.retire(id, session);
        return { kind: "cancelled" };
      }
      const entry = {
        identity: identityOf(record),
        session,
        leases: new Map<symbol, boolean>(),
        ownership: { kind: "local" as const },
      };
      this.entries.set(id, entry);
      return entry;
    } catch (error) {
      this.retire(id, session);
      throw error;
    }
  }

  private async acknowledgeInitialization(key: ResourceKey, databaseName: string): Promise<void> {
    for (;;) {
      const current = await this.metadata.readResource(key);
      if (current?.resource.content.kind !== "exact")
        throw new Error("Initialized resource content disappeared");
      const content = current.resource.content;
      if (content.databaseName !== databaseName)
        throw new Error("Initialized resource content identity changed");
      if (content.initialization !== "reserved") return;
      const { initialization: _reserved, ...initialized } = content;
      const result = await this.metadata.commitResource({
        expectedRevision: current.resource.revision,
        next: {
          resource: {
            ...current.resource,
            revision: current.resource.revision + 1,
            content: initialized,
          },
          intents: current.intents,
        },
      });
      if (result === "committed") return;
    }
  }

  private async clearExactContentTracked(input: {
    projectId: string;
    key: ResourceKey;
    documentId: string;
    databaseName: string;
  }): Promise<void> {
    if (this.state !== "open") throw new Error("Resource content is closing");
    const id = resourceKey(input.key);
    await this.finishRetirement(id);
    const entry = this.entries.get(id);
    if (entry) {
      if (
        entry.identity.documentId !== input.documentId ||
        entry.identity.databaseName !== input.databaseName ||
        entry.ownership.kind !== "local"
      )
        throw new Error("Local cleanup does not match resource content");
      this.entries.delete(id);
      await entry.session.destroy({ clearPersistence: true });
      return;
    }
    await this.sessions.whenAuthorityReady();
    if (this.state !== "open") throw new Error("Resource content is closing");
    const session = this.sessions.createDetached({
      accountId: this.accountId,
      projectId: input.projectId,
      documentId: input.documentId,
      persistenceKey: input.databaseName,
    });
    await session.destroy({ clearPersistence: true });
  }

  private releaseLease(id: string, entry: ContentEntry, lease: symbol): void {
    entry.leases.delete(lease);
    if (entry.leases.size > 0 || this.entries.get(id) !== entry) return;
    if (entry.ownership.kind === "transferring") return;
    this.entries.delete(id);
    if (entry.ownership.kind === "registry") this.releaseRegistryOwnership(entry.ownership);
    else this.retire(id, entry.session);
  }

  private releaseRegistryOwnership(
    ownership: Extract<ContentEntry["ownership"], { kind: "registry" }>,
  ): void {
    for (const retained of ownership.ownershipByProject.values()) retained.release();
    ownership.ownershipByProject.clear();
  }

  private retire(id: string, session: DocumentSession): void {
    const existing = this.retirements.get(id);
    if (existing && existing.session !== session)
      throw new Error("A different resource content session is still retiring");
    if (!existing) this.retirements.set(id, { session, attempt: null });
    void this.destroy(id, session).catch(() => undefined);
  }

  private async finishRetirement(id: string): Promise<void> {
    const retirement = this.retirements.get(id);
    if (retirement) await this.destroy(id, retirement.session);
  }

  private destroy(id: string, session: DocumentSession): Promise<void> {
    const retirement = this.retirements.get(id);
    if (!retirement || retirement.session !== session)
      return Promise.reject(new Error("Resource content retirement identity changed"));
    if (retirement.attempt) return retirement.attempt;
    const attempt = session.destroy().then(
      () => {
        if (this.retirements.get(id) === retirement) this.retirements.delete(id);
      },
      (error: unknown) => {
        if (this.retirements.get(id) === retirement && retirement.attempt === attempt)
          retirement.attempt = null;
        throw error;
      },
    );
    retirement.attempt = attempt;
    return attempt;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
    return operation;
  }

  beginClose(): void {
    if (this.state !== "open") return;
    this.state = "closing";
    for (const [id, entry] of this.entries) {
      if (entry.ownership.kind === "transferring") continue;
      this.entries.delete(id);
      if (entry.ownership.kind === "registry") this.releaseRegistryOwnership(entry.ownership);
      else this.retire(id, entry.session);
    }
  }

  async finishClose(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.operations]);
    for (const [id, entry] of this.entries) {
      this.entries.delete(id);
      if (entry.ownership.kind === "registry") this.releaseRegistryOwnership(entry.ownership);
      else {
        if (entry.ownership.kind === "transferring") {
          try {
            entry.ownership.reservations.abort(entry.ownership.handoff);
          } catch {
            // The registry may already have settled the in-memory reservation during account close.
          }
        }
        this.retire(id, entry.session);
      }
    }
    const results = await Promise.allSettled(
      [...this.retirements].map(([id, retirement]) => this.destroy(id, retirement.session)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Resource content teardown failed");
    this.state = "closed";
  }
}
