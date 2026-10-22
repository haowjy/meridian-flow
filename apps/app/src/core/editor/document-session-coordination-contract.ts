/** Account-scoped document admission, revocation, and lineage continuation contracts. */
import type {
  AvailabilityCommandId,
  AvailabilityGeneration,
  LiveDocumentSessionLease,
} from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import type {
  LocalAdoptionPendingReceipt,
  LocalAdoptionState,
  TerminalLineageReceipt,
} from "./document-session-authority-store";

export type AdmittedDocumentLease = LiveDocumentSessionLease & {
  persistenceGeneration: AvailabilityGeneration;
  exactDatabaseName: string;
};

/**
 * Adopting a local copy runs inside `admit`'s one operation-lock section. Both hooks are
 * synchronous: Web Locks are not reentrant, so nothing in the section may await another lock.
 */
export type LocalAdoptionAdmission = LocalAdoptionPendingReceipt & {
  transfer: {
    prepareCommit(admitted: AdmittedDocumentLease): undefined;
    completeCommit(admitted: AdmittedDocumentLease): undefined;
  };
};

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
    options?: { originLineageHandle?: string; adoption?: LocalAdoptionAdmission },
  ): Promise<AdmittedDocumentLease>;
  connectLocalLineageTerminal(port: LocalLineageTerminalPort): void;
  beginLocalAdoption(receipt: LocalAdoptionPendingReceipt): Promise<LocalAdoptionState>;
  abortLocalAdoption(receipt: LocalAdoptionPendingReceipt): Promise<"aborted" | "stale">;
  /** `deletionVersion` is the exact-ID deletion's namespace version, held by the terminal. */
  revokeDocument(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
    deletionVersion: string | null,
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

/** The registry's own refusals, and coordination refusals translated for its callers. */
export class DocumentSessionAuthorityError extends Error {
  constructor(
    readonly kind:
      | "account-unconfigured"
      | "authority-unavailable"
      | "account-mismatch"
      | "generation-revoked"
      | "stale-lease"
      | "older-command"
      | "command-collision"
      | "purge-pending"
      | "adoption-pending",
    message: string,
  ) {
    super(message);
    this.name = "DocumentSessionAuthorityError";
  }
}
