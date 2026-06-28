import type {
  BillingBalanceResponse,
  BillingProductsResponse,
  BillingTransactionsResponse,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
} from "@meridian/contracts/protocol";
import {
  apiBillingBalancePath,
  apiBillingCheckoutSessionsPath,
  apiBillingPacksPath,
  apiBillingTransactionsPath,
} from "@meridian/contracts/protocol";
import { getJson, postJson } from "./http-client";

export function getBillingBalance(): Promise<BillingBalanceResponse> {
  return getJson(apiBillingBalancePath());
}

export function getBillingTransactions(): Promise<BillingTransactionsResponse> {
  return getJson(apiBillingTransactionsPath());
}

// Route path is still `/api/billing/packs` — only the response shape changed
// (catalog products + Stripe configuration status). The client-side name is
// updated to match the new contract; the path helper is renamed alongside the
// server when both sides land together.
export function getBillingProducts(): Promise<BillingProductsResponse> {
  return getJson(apiBillingPacksPath());
}

export function createCheckoutSession(
  body: CreateCheckoutSessionRequest,
): Promise<CreateCheckoutSessionResponse> {
  return postJson(apiBillingCheckoutSessionsPath(), body);
}
