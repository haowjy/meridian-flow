/** Port for durable ahead-ref identities (contract §9.2). */
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";

export type AheadRegistration = {
  /** The bare UUID of the `ahead:<uuid>` ref; the table key. */
  aheadId: string;
  holderProjectId: ProjectId;
  /** Decoded canonical Context URI of the (extension-bearing) target. */
  address: string;
  /**
   * The planned identity (an import's unlanded file) the ref awaits, persisted: only that
   * document settles it, wherever it lands and whatever address the ref spells, until
   * `releaseAwaiting`. A document already live settles it at registration.
   */
  awaitedDocumentId?: DocumentId;
};

/** Which holders' index rows a registration recovery reads. */
export type AheadRecoveryScope =
  | { documentId: DocumentId }
  | { projectId: ProjectId; personalOwnerId?: UserId };

/** One page of recovery, in ahead-id order, strictly after `after`. */
export type AheadRecoveryPage = { after?: string; limit: number };

/**
 * `next` is the last ahead id attempted when the page was full (more may follow), else null.
 * Attempted, not registered: a permanently failing ref is passed over, never retried in place.
 */
export type AheadRecoveryProgress = { registered: number; next: string | null };

/** Raised when registration would open a root transaction under a caller's transaction (§6.1). */
export class RegistrationInsideTransactionError extends Error {
  constructor() {
    super("Ahead-ref registration must run outside an existing Drizzle transaction");
    this.name = "RegistrationInsideTransactionError";
  }
}

export interface LinkAheadRegistry {
  /**
   * Independent root transaction. Takes the namespace keys of refs awaiting nothing, sorted (no
   * Work or holder lock), then the awaited-id stripes; inserts idempotently by id (re-registering
   * an id for another address throws); then settles any row whose address already holds a live
   * document, or whose awaited document is already live in the ref's project.
   */
  register(registrations: readonly AheadRegistration[]): Promise<void>;
  /**
   * Inside the caller's transaction, which already holds each arrival's namespace key and takes
   * none later. Takes the arriving ids' awaited-id stripes, then settles every ref awaiting an
   * arrival (whatever its address) and every ref awaiting nothing at an arrival's address;
   * skips deleted documents and draft-only membership. Returns rows settled.
   */
  settleArrivals(documentIds: readonly DocumentId[]): Promise<number>;
  /**
   * The awaited identities will never land: their refs become ordinary ahead refs, settled at
   * once to a live document already at their address, as registration would. Joins the caller
   * transaction. Returns rows released.
   */
  releaseAwaiting(documentIds: readonly DocumentId[]): Promise<number>;
  /**
   * Client-minted refs (contract §11.3): registers one page of ahead ids the link index holds
   * with no registry row, each independently, in scope (everywhere when absent). Logs and skips
   * a failing ref, so one bad address never blocks the rest.
   */
  registerUnregistered(
    scope: AheadRecoveryScope | undefined,
    page: AheadRecoveryPage,
  ): Promise<AheadRecoveryProgress>;
}
