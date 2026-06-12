// @ts-nocheck
/**
 * Purpose: Public billing-domain surface for runtime credit metering.
 * Key decisions: exposes only the ledger port/adapters and pricing converter;
 * Stripe remains a future adapter behind the grant-source seam.
 */
export { createDrizzleCreditLedger } from "./adapters/drizzle/credit-ledger.js";
export { createInMemoryCreditLedger } from "./adapters/in-memory/credit-ledger.js";
export type {
  CreditDebitInput,
  CreditGrantInput,
  CreditGrantSource,
  CreditLedger,
} from "./domain/credit-ledger.js";
export type { ComputedModelCost, ModelTokenRate } from "./domain/pricing.js";
export { computeModelCost, findModelTokenRate, MODEL_TOKEN_RATES } from "./domain/pricing.js";
