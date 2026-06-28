/** Shared billing-domain errors surfaced by HTTP route adapters. */
export class BillingRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingRequestError";
  }
}
