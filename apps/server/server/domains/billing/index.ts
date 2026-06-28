/** Public billing-domain surface for credits ledger, catalog, and free-tier grants. */
export { createDrizzleCreditLedger } from "./adapters/drizzle/credit-ledger.js";
export { createInMemoryCreditLedger } from "./adapters/in-memory/credit-ledger.js";
export type {
  BillingCatalogServerEntry,
  BillingPlanCatalogEntry,
  ExtraUsageConfig,
} from "./domain/catalog.js";
export {
  BILLING_CATALOG,
  BILLING_PLANS,
  catalogEntry,
  EXTRA_USAGE,
  FREE_TIER,
  publicCatalogEntry,
} from "./domain/catalog.js";
export type {
  CreditDebitInput,
  CreditGrantInput,
  CreditGrantResult,
  CreditGrantSource,
  CreditLedger,
  CreditLotView,
  CreditTransactionRow,
} from "./domain/credit-ledger.js";
export { assertPositiveMillicredits } from "./domain/credit-ledger.js";
export type { FreeTierClock, FreeTierConfig } from "./domain/free-grants.js";
export { ensureFreeTier } from "./domain/free-grants.js";
