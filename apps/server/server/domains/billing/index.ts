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
export type {
  ComputedModelCost,
  LayeredTokenRateSourceDeps,
  ModelCatalogPricingRecord,
  ModelTokenRate,
  ModelTokenRateSource,
  ResolvedModelTokenRate,
} from "./domain/pricing.js";
export {
  computeModelCost,
  configureModelTokenRateSource,
  createDefaultModelTokenRateSource,
  createLayeredTokenRateSource,
  findModelTokenRate,
  MOCK_FIXTURE_TOKEN_RATES,
  modelTokenRateSource,
} from "./domain/pricing.js";
