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
  apiBillingProductsPath,
  apiBillingTransactionsPath,
} from "@meridian/contracts/protocol";
import { getJson, postJson } from "./http-client";

export function getBillingBalance(): Promise<BillingBalanceResponse> {
  return getJson(apiBillingBalancePath());
}

export function getBillingTransactions(): Promise<BillingTransactionsResponse> {
  return getJson(apiBillingTransactionsPath());
}

export function getBillingProducts(): Promise<BillingProductsResponse> {
  return getJson(apiBillingProductsPath());
}

export function createCheckoutSession(
  body: CreateCheckoutSessionRequest,
): Promise<CreateCheckoutSessionResponse> {
  return postJson(apiBillingCheckoutSessionsPath(), body);
}
