/**
 * Durable coordinator that transfers one proven local Y.Doc into authorized registry ownership.
 *
 * The state is the pair (obligation, room persistence), and every `reconcile` pass derives its next
 * step from it: Owed (obligation) -> Reserved (room `adopting-local`, no generation) -> Committed
 * (room `bindable{G}`, written by the one fenced commit that also installs the lease) -> Settled
 * (acknowledgement writes G into the resource and drops the obligation). No generation is stored
 * before the commit that admits it, so an interrupted pass leaves nothing a later pass must repeat.
 */
import {
  type AvailabilityGeneration,
  assertAvailabilityGeneration,
} from "@meridian/contracts/protocol";
import {
  acknowledgeSessionAdoption,
  type ResourceKey,
  type ResourceMetadataStore,
  type ResourceNamespaceLock,
  type ResourceRecord,
} from "@meridian/resource-replica";
import type { DocumentSession } from "@/core/editor/document-session";
import type {
  LocalDocumentSessionAdoptionPort,
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
    this.content.abortTransfer(key);
  }

  private async reconcileTracked(key: ResourceKey): Promise<ResourceSessionAdoptionResult> {
    const initial = await this.metadata.readResource(key);
    const witness = exactAdoption(initial);
    if (!witness) {
      this.content.abortTransfer(key);
      return "idle";
    }
    const opened = await this.content.open(
      witness.projectId,
      key,
      `session-adoption:${witness.transitionId}`,
    );
    if (opened.kind !== "opened") return opened.kind === "cancelled" ? "blocked" : "waiting";
    try {
      const result = await this.reconcileOpen(key, witness, opened.handle.session);
      if (result === "adopted") opened.handle.session.reportAdoptionStalled(false);
      return result;
    } catch (error) {
      opened.handle.session.reportAdoptionStalled(true);
      throw error;
    } finally {
      opened.handle.release();
    }
  }

  private async reconcileOpen(
    key: ResourceKey,
    witness: SessionAdoption,
    session: DocumentSession,
  ): Promise<ResourceSessionAdoptionResult> {
    const transfer = await this.content.reserveTransfer(
      {
        projectId: witness.projectId,
        key,
        transitionId: witness.transitionId,
        documentId: witness.documentId,
        identityRevision: witness.identityRevision,
        databaseName: witness.exactDatabaseName,
      },
      this.reservations,
    );
    // Committed in this context while an earlier acknowledgement failed: only the write remains.
    if (transfer.kind === "adopted")
      return this.acknowledge(key, witness, transfer.ownership.persistenceGeneration);
    if (transfer.kind === "waiting") return "waiting";

    let lease: { persistenceGeneration: string };
    try {
      const authority = await this.availability.resolve(
        witness.projectId,
        witness.documentId,
        this.close.signal,
      );
      if (authority.kind !== "available" || authority.documentId !== witness.documentId) {
        session.reportAdoptionStalled(true);
        return "waiting";
      }
      assertAvailabilityGeneration(authority.generation);
      const pending = {
        documentId: witness.documentId,
        transitionId: witness.transitionId,
        lineageHandle: key.handle,
        exactDatabaseName: witness.exactDatabaseName,
      };
      const state = await this.adoption.begin(pending);
      if (state.kind === "terminal") return "waiting";
      if (state.kind === "mismatch")
        throw new Error("Session adoption persistence authority belongs to another lineage");
      const current = await this.lock.run(key, async () =>
        exactAdoption(await this.metadata.readResource(key)),
      );
      if (current.kind === "busy") return "blocked";
      if (current.value?.transitionId !== witness.transitionId) {
        // The resource moved on: a newer restore must not inherit this reservation.
        if (state.kind === "reserved") await this.adoption.abort(state.receipt);
        return "idle";
      }
      ({ lease } = await this.adoption.adopt({
        projectId: witness.projectId,
        documentId: witness.documentId,
        admission: authority.generation,
        handoff: transfer.handoff,
        pending: state.kind === "reserved" ? state.receipt : pending,
      }));
    } finally {
      this.content.abortTransfer(key);
    }
    return this.acknowledge(key, witness, lease.persistenceGeneration);
  }

  /** Writes the committed incarnation into the resource and drops the obligation, in one commit. */
  private async acknowledge(
    key: ResourceKey,
    witness: SessionAdoption,
    generation: string,
  ): Promise<ResourceSessionAdoptionResult> {
    const settled = await this.lock.run(key, async () => {
      for (;;) {
        const current = await this.metadata.readResource(key);
        if (exactAdoption(current)?.transitionId !== witness.transitionId) return "idle" as const;
        const write = current && acknowledgeSessionAdoption(current, generation);
        if (!write || (await this.metadata.commitResource(write)) === "committed")
          return "adopted" as const;
      }
    });
    return settled.kind === "busy" ? "blocked" : settled.value;
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
