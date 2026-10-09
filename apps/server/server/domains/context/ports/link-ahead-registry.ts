/** Port for durable ahead-ref identities (contract §9.2). */
import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";

export type AheadRegistration = {
  /** The bare UUID of the `ahead:<uuid>` ref; the table key. */
  aheadId: string;
  holderProjectId: ProjectId;
  /** Decoded canonical Context URI of the (extension-bearing) target. */
  address: string;
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
   * settles any row whose address already holds a live document.
   */
  register(registrations: readonly AheadRegistration[]): Promise<void>;
  /**
   * Inside the caller's transaction, which already holds each arrival's namespace key. Takes no
   * lock; skips deleted documents and draft-only membership. Returns rows settled.
   */
  settleArrivals(documentIds: readonly DocumentId[]): Promise<number>;
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
