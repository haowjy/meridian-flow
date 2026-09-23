/** Durable coordinator that transfers one proven local Y.Doc into authorized registry ownership. */
import {
  type AvailabilityGeneration,
  assertAvailabilityGeneration,
} from "@meridian/contracts/protocol";
import {
  acknowledgeSessionAdoption,
  planSessionAdoptionGeneration,
  type ResourceKey,
  type ResourceMetadataStore,
  type ResourceNamespaceLock,
  type ResourceRecord,
} from "@meridian/resource-replica";
import type {
  LocalDocumentSessionAdoptionPort,
  LocalDocumentSessionHandoff,
  LocalDocumentSessionReservationPort,
} from "@/core/editor/local-document-session-adoption";
import type { ResourceContentAccess } from "./resource-content-access";

export interface ResourceAvailabilityResolver {
  resolve(
    projectId: string,
    documentId: string,
    signal: AbortSignal,
  ): Promise<
    | { kind: "available"; documentId: string; generation: AvailabilityGeneration }
    | { kind: "unavailable" | "failed" }
  >;
}

export type ResourceSessionAdoptionResult = "idle" | "blocked" | "waiting" | "adopted";

type SessionAdoption = NonNullable<ResourceRecord["resource"]["obligations"]["sessionAdoption"]>;

function exactAdoption(record: ResourceRecord | null): SessionAdoption | null {
  if (!record) return null;
  const adoption = record.resource.obligations.sessionAdoption;
  if (!adoption) return null;
  if (
    record.resource.lifecycle.kind !== "acknowledged" ||
    record.resource.identity.documentId !== adoption.documentId ||
    record.resource.identity.revision !== adoption.identityRevision ||
    record.resource.content.kind !== "exact" ||
    record.resource.content.databaseName !== adoption.exactDatabaseName ||
    record.resource.content.initialization === "reserved"
  ) {
    throw new Error("Session adoption obligation no longer matches exact resource content");
  }
  return adoption;
}

export class ResourceSessionAdoptionCoordinator {
  private readonly operations = new Map<string, Promise<ResourceSessionAdoptionResult>>();
  private readonly activeTransfers = new Map<
    string,
    { key: ResourceKey; handoff: LocalDocumentSessionHandoff }
  >();
  private readonly close = new AbortController();
  private closing = false;

  constructor(
    readonly accountId: string,
    private readonly metadata: ResourceMetadataStore,
    private readonly content: ResourceContentAccess,
    private readonly reservations: LocalDocumentSessionReservationPort,
    private readonly adoption: LocalDocumentSessionAdoptionPort,
    private readonly lock: ResourceNamespaceLock,
    private readonly availability: ResourceAvailabilityResolver,
  ) {
    if (
      metadata.accountId !== accountId ||
      content.accountId !== accountId ||
      lock.accountId !== accountId
    ) {
      throw new Error("Resource session adoption account mismatch");
    }
  }

  reconcile(key: ResourceKey): Promise<ResourceSessionAdoptionResult> {
    if (this.closing) return Promise.reject(new Error("Resource session adoption is closing"));
    const id = encodeURIComponent(key.handle);
    const existing = this.operations.get(id);
    if (existing) return existing;
    const operation = this.reconcileTracked(key).finally(() => {
      if (this.operations.get(id) === operation) this.operations.delete(id);
    });
    this.operations.set(id, operation);
    return operation;
  }

  cancel(key: ResourceKey): void {
    this.abortActiveTransfer(encodeURIComponent(key.handle));
  }

  private async reconcileTracked(key: ResourceKey): Promise<ResourceSessionAdoptionResult> {
    const initial = await this.metadata.readResource(key);
    const witness = exactAdoption(initial);
    const transferId = encodeURIComponent(key.handle);
    if (!witness) {
      this.abortActiveTransfer(transferId);
      return "idle";
    }
    const opened = await this.content.open(
      witness.projectId,
      key,
      `session-adoption:${witness.transitionId}`,
    );
    if (opened.kind !== "opened") return opened.kind === "cancelled" ? "blocked" : "waiting";
    try {
      return await this.reconcileOpen(key, witness);
    } finally {
      opened.handle.release();
    }
  }

  private async reconcileOpen(
    key: ResourceKey,
    witness: SessionAdoption,
  ): Promise<ResourceSessionAdoptionResult> {
    const transfer = await this.content.reserveTransfer(
      {
        projectId: witness.projectId,
        key,
        transitionId: witness.transitionId,
        documentId: witness.documentId,
        identityRevision: witness.identityRevision,
        databaseName: witness.exactDatabaseName,
        requireRetainedLease: true,
      },
      this.reservations,
    );
    if (transfer.kind === "adopted") {
      this.activeTransfers.delete(encodeURIComponent(key.handle));
      return this.finishRecordedAdoption(key, witness, transfer.ownership.persistenceGeneration);
    }
    if (transfer.kind === "waiting") return "waiting";
    this.activeTransfers.set(encodeURIComponent(key.handle), { key, handoff: transfer.handoff });

    const validated = await this.lock.run(key, async () => {
      const current = exactAdoption(await this.metadata.readResource(key));
      return current?.transitionId === witness.transitionId ? current : null;
    });
    if (validated.kind === "busy") {
      this.abortActiveTransfer(encodeURIComponent(key.handle));
      return "blocked";
    }
    if (!validated.value) {
      this.abortActiveTransfer(encodeURIComponent(key.handle));
      return "idle";
    }
    const authority = await this.availability.resolve(
      witness.projectId,
      witness.documentId,
      this.close.signal,
    );
    if (authority.kind !== "available" || authority.documentId !== witness.documentId)
      return "waiting";
    assertAvailabilityGeneration(authority.generation);
    const authorityState = await this.adoption.inspect({
      documentId: witness.documentId,
      lineageHandle: key.handle,
      exactDatabaseName: witness.exactDatabaseName,
      generation: authority.generation,
    });
    if (authorityState === "terminal") {
      this.abortActiveTransfer(encodeURIComponent(key.handle));
      return "waiting";
    }
    if (authorityState === "mismatch") {
      this.abortActiveTransfer(encodeURIComponent(key.handle));
      throw new Error("Session adoption persistence authority belongs to another lineage");
    }
    const pending =
      authorityState === "bindable"
        ? null
        : await this.adoption.begin({
            projectId: witness.projectId,
            documentId: witness.documentId,
            lineageHandle: key.handle,
            exactDatabaseName: witness.exactDatabaseName,
            transitionId: witness.transitionId,
          });
    const pinned = await this.lock.run(key, async () => {
      const current = exactAdoption(await this.metadata.readResource(key));
      if (!current || current.transitionId !== witness.transitionId) return "idle" as const;
      await this.pinGeneration(key, authority.generation);
      return "pinned" as const;
    });
    if (pinned.kind === "busy") return "blocked";
    if (pinned.value === "idle") {
      if (pending) await this.adoption.abort(pending);
      this.abortActiveTransfer(encodeURIComponent(key.handle));
      return "idle";
    }
    const adoptionPending = pending ?? {
      documentId: witness.documentId,
      transitionId: witness.transitionId,
      lineageHandle: key.handle,
      exactDatabaseName: witness.exactDatabaseName,
      targetGeneration: authority.generation,
    };
    try {
      await this.adoption.bindAndAdopt({
        projectId: witness.projectId,
        documentId: witness.documentId,
        generation: authority.generation,
        handoff: transfer.handoff,
        pending: adoptionPending,
      });
    } catch (error) {
      const state = await this.adoption.inspect({
        documentId: witness.documentId,
        lineageHandle: key.handle,
        exactDatabaseName: witness.exactDatabaseName,
        generation: authority.generation,
      });
      if (state === "terminal" || state === "clear" || state === "mismatch") {
        this.abortActiveTransfer(encodeURIComponent(key.handle));
      }
      throw error;
    }
    this.activeTransfers.delete(encodeURIComponent(key.handle));
    const acknowledged = await this.lock.run(key, async () => {
      const current = exactAdoption(await this.metadata.readResource(key));
      if (!current || current.transitionId !== witness.transitionId) return "idle" as const;
      await this.acknowledge(key, authority.generation);
      return "adopted" as const;
    });
    return acknowledged.kind === "busy" ? "blocked" : acknowledged.value;
  }

  private abortActiveTransfer(id: string): void {
    const active = this.activeTransfers.get(id);
    if (!active) return;
    this.activeTransfers.delete(id);
    this.content.abortTransfer(active.key, active.handoff);
  }

  private async finishRecordedAdoption(
    key: ResourceKey,
    witness: SessionAdoption,
    generation: string,
  ): Promise<ResourceSessionAdoptionResult> {
    const committed = await this.lock.run(key, async () => {
      const current = exactAdoption(await this.metadata.readResource(key));
      if (!current || current.transitionId !== witness.transitionId) return "idle" as const;
      await this.pinGeneration(key, generation);
      await this.acknowledge(key, generation);
      return "adopted" as const;
    });
    return committed.kind === "busy" ? "blocked" : committed.value;
  }

  private async pinGeneration(key: ResourceKey, generation: string): Promise<void> {
    for (;;) {
      const current = await this.metadata.readResource(key);
      const adoption = exactAdoption(current);
      if (!current || !adoption) return;
      if (adoption.generation === generation) return;
      const write = planSessionAdoptionGeneration(current, generation);
      if (!write || (await this.metadata.commitResource(write)) === "committed") return;
    }
  }

  private async acknowledge(key: ResourceKey, generation: string): Promise<void> {
    for (;;) {
      const current = await this.metadata.readResource(key);
      const adoption = exactAdoption(current);
      if (!current || !adoption) return;
      if (adoption.generation !== generation)
        throw new Error("Session adoption generation changed before acknowledgement");
      const write = acknowledgeSessionAdoption(current);
      if (!write || (await this.metadata.commitResource(write)) === "committed") return;
    }
  }

  beginClose(): void {
    if (this.closing) return;
    this.closing = true;
    this.close.abort(new Error("Resource session adoption is closing"));
  }

  async finishClose(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.operations.values()]);
  }
}
