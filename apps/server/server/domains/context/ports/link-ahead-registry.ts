import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";

export type AheadRegistration = {
  aheadId: string;
  holderProjectId: ProjectId;
  address: string;
};

/** Raised when registration would try to open a root transaction under a write transaction. */
export class RegistrationInsideTransactionError extends Error {
  constructor() {
    super("Ahead-ref registration must run outside an existing Drizzle transaction");
    this.name = "RegistrationInsideTransactionError";
  }
}

export interface LinkAheadRegistry {
  register(registrations: readonly AheadRegistration[]): Promise<void>;
  settleArrivals(documentIds: readonly DocumentId[]): Promise<number>;
}
