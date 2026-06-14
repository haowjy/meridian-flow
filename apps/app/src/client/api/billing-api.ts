import type {
  BillingBalanceResponse,
  BillingPacksPlansResponse,
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

export function getBillingPacks(): Promise<BillingPacksPlansResponse> {
  return getJson(apiBillingPacksPath());
}

export function createCheckoutSession(
  body: CreateCheckoutSessionRequest,
): Promise<CreateCheckoutSessionResponse> {
  return postJson(apiBillingCheckoutSessionsPath(), body);
}
