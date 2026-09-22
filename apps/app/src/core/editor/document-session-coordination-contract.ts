/** Account-scoped document admission, revocation, and lineage continuation contracts. */
import type {
  AvailabilityCommandId,
  AvailabilityGeneration,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type {
  LocalAdoptionPendingReceipt,
  TerminalLineageReceipt,
} from "./document-session-authority-store";

export interface LocalSessionAuthority {
  beginCloseAccountRuntime(): void;
  validateAdmission(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
  }): void;
  installSynchronously(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    persistenceGeneration: AvailabilityGeneration;
    exactDatabaseName: string;
  }): void;
  drainDocument(input: {
    documentId: DocumentId;
    generation: AvailabilityGeneration;
    incarnation: AvailabilityGeneration | null;
    exactDatabaseName?: string | null;
  }): Promise<void>;
  drainAccess(input: {
    documentId: DocumentId;
    projectId: ProjectId;
    generation: AvailabilityGeneration;
    incarnation: AvailabilityGeneration | null;
    exactDatabaseName?: string | null;
  }): Promise<"other-local-project-remains" | "locally-empty">;
  invalidateAll(): Promise<void>;
}

/** The feature-owned local resources participate in the authority close barrier. */
export interface LocalResourceLifetimePort {
  readonly terminal: LocalLineageTerminalPort;
  /** Resolve the resource lineage that owns a document's local content, if one exists. */
  lineageHandleFor(projectId: ProjectId, documentId: DocumentId): Promise<string | null>;
  beginClose(): void;
  finishClose(): Promise<void>;
}

export interface LocalLineageTerminalPort {
  continueTerminal(
    input: TerminalLineageReceipt,
    run: (operation: LocalLineageTerminalOperation) => Promise<void>,
  ): Promise<"completed" | "owned-elsewhere">;
}

export interface LocalLineageTerminalOperation {
  publish(): Promise<void>;
  acknowledge(): Promise<void>;
}

export class DocumentSessionCoordinationError extends Error {
  constructor(
    readonly kind:
      | "authority-unavailable"
      | "generation-revoked"
      | "older-command"
      | "command-collision"
      | "purge-pending"
      | "adoption-pending"
      | "account-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "DocumentSessionCoordinationError";
  }
}

export interface DocumentSessionCrossContextCoordination {
  requireReady(): Promise<void>;
  admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    originLineageHandle?: string,
  ): Promise<
    LiveDocumentSessionLease & {
      persistenceGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
    }
  >;
  connectLocalLineageTerminal(port: LocalLineageTerminalPort): void;
  beginLocalAdoption(receipt: LocalAdoptionPendingReceipt): Promise<LocalAdoptionPendingReceipt>;
  abortLocalAdoption(receipt: LocalAdoptionPendingReceipt): Promise<"aborted" | "stale">;
  inspectLocalLineage(input: {
    documentId: DocumentId;
    lineageHandle: string;
    exactDatabaseName: string;
  }): Promise<"clear" | "adopting" | "bindable" | "terminal" | "mismatch">;
  commitLocalAdoption(
    projectId: ProjectId,
    generation: AvailabilityGeneration,
    pending: LocalAdoptionPendingReceipt,
    transfer: Readonly<{
      prepareCommit(
        admitted: LiveDocumentSessionLease & {
          persistenceGeneration: AvailabilityGeneration;
          exactDatabaseName: string;
        },
      ): void;
      completeCommit(
        admitted: LiveDocumentSessionLease & {
          persistenceGeneration: AvailabilityGeneration;
          exactDatabaseName: string;
        },
      ): Promise<void>;
    }>,
  ): Promise<
    LiveDocumentSessionLease & {
      persistenceGeneration: AvailabilityGeneration;
      exactDatabaseName: string;
    }
  >;
  revokeDocument(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{ revokedThrough: AvailabilityGeneration; persistence: "cleared" }>;
  revokeAccess(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{
    revokedThrough: AvailabilityGeneration;
    persistence: "cleared" | "retained-by-other-lease";
  }>;
  reconcilePending(
    reason: "scan" | "broadcast" | "focus" | "pageshow" | "visible" | "operation" | "account-close",
  ): Promise<void>;
  beginClose(): void;
  close(): Promise<void>;
}
