/** Port for durable ahead-ref identities (contract §9.2). */
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

export type AheadRegistration = {
  /** The bare UUID of the `ahead:<uuid>` ref; the table key. */
  aheadId: string;
  holderProjectId: ProjectId;
  /** Decoded canonical Context URI of the (extension-bearing) target. */
  address: string;
};

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
}
