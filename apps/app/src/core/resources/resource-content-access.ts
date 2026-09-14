/** Account-owned local content access; exact cache usability is independent from remote admission. */
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import type {
  ResourceKey,
  ResourceMetadataStore,
  ResourceRecord,
} from "@meridian/resource-replica";
import type { DocumentSession } from "@/core/editor/document-session";
import type { LocalDocumentSessionFactory } from "@/core/editor/document-session-registry";

export type ResourceContentUnavailableReason =
  | "missing"
  | "unacquired"
  | "uninitialized"
  | "schema-mismatch"
  | "recovering"
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
  leases: Set<symbol>;
};

function resourceKey(key: ResourceKey): string {
  return [key.projectId, key.handle].map(encodeURIComponent).join(":");
}

function localDisposition(record: ResourceRecord | null): ResourceContentUnavailableReason | null {
  if (!record) return "missing";
  if (record.intents.some((intent) => intent.state === "settled-locally")) return "deleted";
  if (record.resource.lifecycle.kind === "terminal") return "terminal";
  if (record.resource.lifecycle.kind === "recovering" || record.resource.recovery)
    return "recovering";
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
  private readonly retirements = new Map<string, DocumentSession>();
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
    key: ResourceKey,
    participantId: string,
    signal?: AbortSignal,
  ): Promise<ResourceContentOpenResult> {
    if (participantId.length === 0) throw new Error("Resource content participant is required");
    return this.track(this.openTracked(key, participantId, signal));
  }

  private async openTracked(
    key: ResourceKey,
    participantId: string,
    signal?: AbortSignal,
  ): Promise<ResourceContentOpenResult> {
    if (this.state !== "open" || this.epoch.aborted || signal?.aborted)
      return { kind: "cancelled" };
    const id = resourceKey(key);
    let entry = this.entries.get(id);
    if (!entry) {
      let opening = this.openings.get(id);
      if (!opening) {
        opening = this.createEntry(key);
        this.openings.set(id, opening);
        void opening.finally(() => this.openings.delete(id)).catch(() => undefined);
      }
      const result = await opening;
      if ("kind" in result) return result;
      entry = result;
    }
    const lease = Symbol(participantId);
    entry.leases.add(lease);
    if (this.state !== "open" || this.epoch.aborted || signal?.aborted) {
      this.releaseLease(id, entry, lease);
      return { kind: "cancelled" };
    }
    let current: ResourceRecord | null;
    try {
      current = await this.metadata.readResource(key);
    } catch (error) {
      this.releaseLease(id, entry, lease);
      throw error;
    }
    const unavailable = localDisposition(current);
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

  private async createEntry(key: ResourceKey): Promise<ContentEntry | ResourceContentOpenResult> {
    const id = resourceKey(key);
    await this.sessions.whenAuthorityReady();
    if (this.state !== "open" || this.epoch.aborted) return { kind: "cancelled" };
    await this.finishRetirement(id);
    if (this.state !== "open" || this.epoch.aborted) return { kind: "cancelled" };
    const record = await this.metadata.readResource(key);
    const unavailable = localDisposition(record);
    if (unavailable || !record) return { kind: "unavailable", reason: unavailable ?? "missing" };
    const content = record.resource.content;
    if (content.kind !== "exact") return { kind: "unavailable", reason: "unacquired" };
    const session = this.sessions.createDetached({
      accountId: this.accountId,
      projectId: record.resource.projectId,
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
        leases: new Set<symbol>(),
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

  private releaseLease(id: string, entry: ContentEntry, lease: symbol): void {
    entry.leases.delete(lease);
    if (entry.leases.size > 0 || this.entries.get(id) !== entry) return;
    this.entries.delete(id);
    this.retire(id, entry.session);
  }

  private retire(id: string, session: DocumentSession): void {
    const existing = this.retirements.get(id);
    if (existing && existing !== session)
      throw new Error("A different resource content session is still retiring");
    this.retirements.set(id, session);
    void this.destroy(id, session).catch(() => undefined);
  }

  private async finishRetirement(id: string): Promise<void> {
    const session = this.retirements.get(id);
    if (session) await this.destroy(id, session);
  }

  private async destroy(id: string, session: DocumentSession): Promise<void> {
    await session.destroy();
    if (this.retirements.get(id) === session) this.retirements.delete(id);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined);
    return operation;
  }

  beginClose(): void {
    if (this.state !== "open") return;
    this.state = "closing";
    for (const [id, entry] of this.entries) this.retire(id, entry.session);
    this.entries.clear();
  }

  async finishClose(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.operations]);
    const results = await Promise.allSettled(
      [...this.retirements].map(([id, session]) => this.destroy(id, session)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Resource content teardown failed");
    this.state = "closed";
  }
}
