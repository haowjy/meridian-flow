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
   * document settles it, by `settleRef` or its own arrival, until `releaseAwaiting`.
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
   * Independent root transaction. Takes the targets' namespace keys sorted (no Work or holder
   * lock), inserts idempotently by id (re-registering an id for another address throws), then
   * settles any row whose address already holds a live document that is not excluded by an
   * awaited identity.
   */
  register(registrations: readonly AheadRegistration[]): Promise<void>;
  /**
   * Settle by identity, never address; joins the caller transaction. A ref awaiting another
   * identity is not settled. Missing refs return null.
   */
  settleRef(
    aheadId: string,
    documentId: DocumentId,
  ): Promise<{ settled: boolean; documentId: DocumentId } | null>;
  /**
   * Inside the caller's transaction, which already holds each arrival's namespace key. Takes no
   * lock; skips deleted documents, draft-only membership and refs awaiting another identity.
   * Returns rows settled.
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
