/**
 * The session registry's private local-transfer facet: reserves a local
 * resource session for one document, then adopts it as that document's live
 * session once the cross-context authority admits it.
 */
import type {
  AvailabilityGeneration,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import type { DocumentSession } from "./document-session";
import {
  compareAvailabilityGeneration,
  type LocalAdoptionPendingReceipt,
} from "./document-session-authority-store";
import {
  DocumentSessionAuthorityError,
  type DocumentSessionCrossContextCoordination,
} from "./document-session-coordination-contract";
import type {
  LocalDocumentSessionAdoptionPort,
  LocalDocumentSessionHandoff,
  LocalDocumentSessionReservationPort,
  LocalDocumentSessionTransfer,
  TransferredDocumentSessionOwnership,
} from "./local-document-session-adoption";

/** What the facet needs from the registry that owns the live rooms. */
export type LocalTransferRegistryPort = {
  requireOpen(): void;
  coordination(): Promise<DocumentSessionCrossContextCoordination>;
  /** Runs a coordination call, translating its refusals into the registry's. */
  translate<T>(operation: () => Promise<T>): Promise<T>;
  /** A live admission is in flight for the document. */
  isAdmitting(documentId: DocumentId): boolean;
  liveRoom(documentId: DocumentId):
    | {
        session: DocumentSession | null;
        persistenceGeneration: AvailabilityGeneration | null;
        exactDatabaseName: string | null;
      }
    | undefined;
  retain(
    ownerId: string,
    leases: Iterable<LiveDocumentSessionLease>,
    options: { detachedDocumentIds?: Iterable<DocumentId> },
  ): void;
  release(ownerId: string): void;
  attachTransport(session: DocumentSession): void;
};

type LocalTransferReservation = {
  handoff: LocalDocumentSessionHandoff;
  transfer: LocalDocumentSessionTransfer;
  settled: Promise<void>;
  settle(): void;
};

function localTransferKey(documentId: DocumentId): string {
  return encodeURIComponent(documentId);
}

export class LocalDocumentSessionTransfers
  implements LocalDocumentSessionReservationPort, LocalDocumentSessionAdoptionPort
{
  private readonly reservations = new Map<string, LocalTransferReservation>();
  private readonly settledHandoffs = new WeakSet<object>();

  constructor(private readonly registry: LocalTransferRegistryPort) {}

  /** Resolves once no transfer reserves the document; live admission waits on it. */
  settled(documentId: DocumentId): Promise<void> | undefined {
    return this.reservations.get(localTransferKey(documentId))?.settled;
  }

  /** The account runtime closed: no reservation can reach adoption. */
  settleAll(): void {
    for (const reservation of this.reservations.values()) {
      this.settledHandoffs.add(reservation.handoff);
      reservation.settle();
    }
    this.reservations.clear();
  }

  reserve(transfer: LocalDocumentSessionTransfer): LocalDocumentSessionHandoff {
    this.registry.requireOpen();
    const key = localTransferKey(transfer.documentId);
    const existing = this.reservations.get(key);
    if (existing) {
      if (
        existing.transfer.session === transfer.session &&
        existing.transfer.projectId === transfer.projectId &&
        existing.transfer.ownerRevision === transfer.ownerRevision
      ) {
        return existing.handoff;
      }
      throw new Error("A different local transfer already reserves this document");
    }
    if (this.registry.isAdmitting(transfer.documentId))
      throw new Error("Live admission already reserves this document");
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const handoff = Object.freeze({}) as LocalDocumentSessionHandoff;
    this.reservations.set(key, {
      handoff,
      transfer,
      settled,
      settle,
    });
    return handoff;
  }

  async begin(input: {
    documentId: DocumentId;
    lineageHandle: string;
    exactDatabaseName: string;
    transitionId: string;
  }): Promise<LocalAdoptionPendingReceipt> {
    this.registry.requireOpen();
    const coordination = await this.registry.coordination();
    return this.registry.translate(() =>
      coordination.beginLocalAdoption({
        documentId: input.documentId,
        transitionId: input.transitionId,
        lineageHandle: input.lineageHandle,
        exactDatabaseName: input.exactDatabaseName,
        targetGeneration: null,
      }),
    );
  }

  async abort(receipt: LocalAdoptionPendingReceipt): Promise<"aborted" | "stale">;
  abort(handoff: LocalDocumentSessionHandoff): void;
  abort(
    input: LocalAdoptionPendingReceipt | LocalDocumentSessionHandoff,
  ): Promise<"aborted" | "stale"> | undefined {
    if ("documentId" in input) {
      return this.registry
        .coordination()
        .then((coordination) =>
          this.registry.translate(() => coordination.abortLocalAdoption(input)),
        );
    }
    for (const [key, reservation] of this.reservations) {
      if (reservation.handoff !== input) continue;
      this.reservations.delete(key);
      this.settledHandoffs.add(input);
      reservation.settle();
      return;
    }
    if (!this.settledHandoffs.has(input)) throw new Error("Local document handoff is not reserved");
  }

  async inspect(input: {
    documentId: DocumentId;
    lineageHandle: string;
    exactDatabaseName: string;
    generation: AvailabilityGeneration;
  }): Promise<"clear" | "adopting" | "bindable" | "terminal" | "mismatch"> {
    const coordination = await this.registry.coordination();
    return coordination.inspectLocalLineage(input);
  }

  async bindAndAdopt(input: {
    projectId: ProjectId;
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    handoff: LocalDocumentSessionHandoff;
    pending: LocalAdoptionPendingReceipt;
  }): Promise<{ lease: LiveDocumentSessionLease; session: DocumentSession }> {
    this.registry.requireOpen();
    compareAvailabilityGeneration(input.generation, input.generation);
    const reservationKey = localTransferKey(input.documentId);
    const reservation = this.reservations.get(reservationKey);
    if (
      !reservation ||
      reservation.handoff !== input.handoff ||
      reservation.transfer.projectId !== input.projectId ||
      reservation.transfer.documentId !== input.documentId
    ) {
      throw new Error("Local document handoff does not own this reservation");
    }
    const coordination = await this.registry.coordination();
    let admitted: Awaited<
      ReturnType<DocumentSessionCrossContextCoordination["commitLocalAdoption"]>
    >;
    try {
      admitted = await this.registry.translate(() =>
        coordination.commitLocalAdoption(input.projectId, input.generation, input.pending, {
          prepareCommit: (lease) => {
            this.registry.requireOpen();
            if (this.reservations.get(reservationKey) !== reservation)
              throw new Error("Local document reservation changed during admission");
            if (
              reservation.transfer.lineageHandle !== input.pending.lineageHandle ||
              reservation.transfer.exactDatabaseName !== lease.exactDatabaseName ||
              reservation.transfer.session.persistenceName !== lease.exactDatabaseName
            )
              throw new Error("Local adoption persistence authority does not match the lineage");
            reservation.transfer.prepareCommit();
          },
          completeCommit: async (lease) => {
            const session = reservation.transfer.session;
            const state = this.registry.liveRoom(input.documentId);
            if (!state || (state.session && state.session !== session))
              throw new Error("A different live session won adoption");
            state.session = session;
            state.persistenceGeneration = input.generation;
            state.exactDatabaseName = input.pending.exactDatabaseName;
            const ownerId = `local-transfer:${input.pending.transitionId}`;
            this.registry.retain(ownerId, [lease], { detachedDocumentIds: [input.documentId] });
            let released = false;
            const ownership: TransferredDocumentSessionOwnership = Object.freeze({
              lease,
              persistenceGeneration: input.generation,
              exactDatabaseName: input.pending.exactDatabaseName,
              release: () => {
                if (released) return;
                released = true;
                this.registry.release(ownerId);
              },
            });
            try {
              await reservation.transfer.completeCommit(ownership);
            } catch (error) {
              ownership.release();
              if (state.session === session) state.session = null;
              throw error;
            }
            this.reservations.delete(reservationKey);
            this.settledHandoffs.add(reservation.handoff);
            reservation.settle();
          },
        }),
      );
    } catch (error) {
      if (
        error instanceof DocumentSessionAuthorityError &&
        error.kind === "generation-revoked" &&
        this.reservations.get(reservationKey) === reservation
      ) {
        this.reservations.delete(reservationKey);
        this.settledHandoffs.add(reservation.handoff);
        reservation.settle();
      }
      throw error;
    }
    const session = reservation.transfer.session;
    const state = this.registry.liveRoom(input.documentId);
    if (!state || state.session !== session)
      throw new Error("Local adoption did not converge on its reserved session");
    try {
      this.registry.attachTransport(session);
    } catch {
      // A later bind/open retries attachment on this same canonical session.
    }
    return { lease: admitted, session };
  }
}
