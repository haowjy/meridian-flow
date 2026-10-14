/** Private facets for transferring one local resource session into admitted live ownership. */
import type {
  AvailabilityGeneration,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import type { DocumentSession } from "./document-session";
import type {
  LocalAdoptionPendingReceipt,
  LocalAdoptionState,
} from "./document-session-authority-store";
import type { AdmittedDocumentLease } from "./document-session-coordination-contract";

declare const handoffBrand: unique symbol;

export type TransferredDocumentSessionOwnership = Readonly<{
  lease: LiveDocumentSessionLease;
  persistenceGeneration: AvailabilityGeneration;
  exactDatabaseName: string;
  release(): void;
}>;

export type LocalDocumentSessionTransfer = Readonly<{
  projectId: ProjectId;
  documentId: DocumentId;
  session: DocumentSession;
  ownerRevision: number;
  lineageHandle: string;
  exactDatabaseName: string;
  /** Throws before the durable ownership transition if the owner record moved. */
  prepareCommit(): void;
  /** Converges owner memory inside the commit's one operation-lock section: it cannot await. */
  completeCommit(ownership: TransferredDocumentSessionOwnership): void;
}>;

export type LocalDocumentSessionHandoff = Readonly<{
  [handoffBrand]: true;
}>;

export interface LocalDocumentSessionReservationPort {
  reserve(transfer: LocalDocumentSessionTransfer): LocalDocumentSessionHandoff;
  /** Exactly settles a reservation that cannot reach a server-row adoption. */
  abort(handoff: LocalDocumentSessionHandoff): void;
}

export interface LocalDocumentSessionAdoptionPort {
  /** Reserves the local copy, or reports the durable state that already owns it. */
  begin(input: LocalAdoptionPendingReceipt): Promise<LocalAdoptionState>;
  abort(receipt: LocalAdoptionPendingReceipt): Promise<"aborted" | "stale">;
  /** Commits the reservation at a fresh `admission`, in one fenced section. */
  adopt(input: {
    projectId: ProjectId;
    documentId: DocumentId;
    admission: AvailabilityGeneration;
    handoff: LocalDocumentSessionHandoff;
    pending: LocalAdoptionPendingReceipt;
  }): Promise<{ lease: AdmittedDocumentLease; session: DocumentSession }>;
}
