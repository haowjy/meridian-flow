/**
 * Purpose: Public billing-domain surface for runtime credit metering.
 * Key decisions: exposes only the ledger port/adapters and pricing converter;
 * Stripe remains a future adapter behind the grant-source seam.
 */
export { createDrizzleCreditLedger } from "./adapters/drizzle/credit-ledger.js";
export { createInMemoryCreditLedger } from "./adapters/in-memory/credit-ledger.js";
export type {
  CreditBalanceBreakdown,
  CreditDebitInput,
  CreditGrantInput,
  CreditGrantSource,
  CreditLedger,
  CreditTransactionSummary,
} from "./domain/credit-ledger.js";
export {
  createFreeGrantPipeline,
  createGrantingCreditLedger,
  FREE_MONTHLY_CREDITS,
  FREE_MONTHLY_MILLICREDITS,
  monthlyGrantReason,
} from "./domain/free-grants.js";
export type { ComputedModelCost, ModelTokenRate } from "./domain/pricing.js";
export { computeModelCost, findModelTokenRate, MODEL_TOKEN_RATES } from "./domain/pricing.js";
