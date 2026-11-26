import type { DocumentId, ProjectId, UserId } from "@meridian/contracts/runtime";

export type AheadRegistration = AheadHolder & {
  aheadId: string;
  /** Decoded canonical Context URI of the (extension-bearing) target. */
  address: string;
};

/**
 * Who names the address: a holder read in a project, or a home document read in none, which
 * can name only its account's home folder.
 */
export type AheadHolder = { holderProjectId: ProjectId } | { holderUserId: UserId };

/** Which holders' index rows a registration recovery reads: one holder's. */
export type AheadRecoveryScope = { documentId: DocumentId };

/** One page of recovery, in ahead-id order, strictly after `after`. */
export type AheadRecoveryPage = { after?: string; limit: number };

/**
 * `next` is the last ahead id attempted when the page was full (more may follow), else null.
 * Attempted, not registered: a permanently failing ref is passed over, never retried in place.
 */
export type AheadRecoveryProgress = { registered: number; next: string | null };

export class UnregistrableAheadRefError extends RangeError {
  constructor(
    readonly aheadId: string,
    readonly address: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UnregistrableAheadRefError";
  }
}

export class RegistrationInsideTransactionError extends Error {
  constructor() {
    super("Ahead-ref registration must run outside an existing Drizzle transaction");
    this.name = "RegistrationInsideTransactionError";
  }
}

export interface LinkAheadRegistry {
  /**
   * Throws `UnregistrableAheadRefError` for a ref it refuses for good (the whole batch
   * rolls back; register refs one by one to keep the rest). Independent root transaction. Takes
   * the targets' namespace keys sorted (no Work, draft or holder lock), inserts idempotently by id (re-registering an id for another address
   * throws), then settles any row whose address already holds a live document. With a
   * `draftId` it is idempotent per (ahead id, draft), not per row: a ref with no live
   * settlement whose address holds exactly one document in that draft's view is settled
   * there, whether or not the id was registered before.
   */
  register(registrations: readonly AheadRegistration[]): Promise<void>;
  registerInCommand(registrations: readonly AheadRegistration[]): Promise<void>;
  registerWithinTransaction(registrations: readonly AheadRegistration[]): Promise<void>;
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
