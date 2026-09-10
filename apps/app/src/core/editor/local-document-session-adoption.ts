/** Private facets for transferring one local Untitled session into admitted live ownership. */
import type {
  AvailabilityGeneration,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

import type { DocumentSession } from "./document-session";
import type { LocalAdoptionPendingReceipt } from "./document-session-authority-store";

declare const handoffBrand: unique symbol;

export type LocalDocumentSessionTransfer = Readonly<{
  projectId: ProjectId;
  documentId: DocumentId;
  session: DocumentSession;
  ownerRevision: number;
  lineageHandle: string;
  exactDatabaseName: string;
  /** Throws before the durable ownership transition if the owner record moved. */
  prepareCommit(): void;
  /** Converges owner memory and releases HL while final O revalidation is retained. */
  completeCommit(): Promise<void>;
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
  begin(input: {
    projectId: ProjectId;
    documentId: DocumentId;
    lineageHandle: string;
    exactDatabaseName: string;
    transitionId: string;
  }): Promise<LocalAdoptionPendingReceipt>;
  abort(receipt: LocalAdoptionPendingReceipt): Promise<"aborted" | "stale">;
  inspect(input: {
    documentId: DocumentId;
    lineageHandle: string;
    exactDatabaseName: string;
  }): Promise<"clear" | "adopting" | "bindable" | "terminal" | "mismatch">;
  recover(input: {
    projectId: ProjectId;
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    lineageHandle: string;
  }): Promise<{ lease: LiveDocumentSessionLease; session: DocumentSession }>;
  bindAndAdopt(input: {
    projectId: ProjectId;
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    handoff: LocalDocumentSessionHandoff;
    pending: LocalAdoptionPendingReceipt;
  }): Promise<{ lease: LiveDocumentSessionLease; session: DocumentSession }>;
}
