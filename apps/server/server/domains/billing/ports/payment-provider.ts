import type { BillingCatalogEntry } from "@meridian/contracts/protocol";

export type PaymentProviderMode = "stripe" | "fake";

export interface PaymentProviderStatus {
  mode: PaymentProviderMode;
  needsCredentials: boolean;
  message: string | null;
}

export interface CheckoutSessionInput {
  userId: string;
  projectId: string;
  entry: BillingCatalogEntry;
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSessionResult {
  id: string;
  url: string;
  mode: PaymentProviderMode;
  needsCredentials: boolean;
}

export type PaymentWebhookEvent =
  | {
      kind: "checkout.completed";
      sessionId: string;
      userId: string;
      projectId: string | null;
      entryId: string;
      customerId: string | null;
      subscriptionId: string | null;
      periodStart: string | null;
      periodEnd: string | null;
    }
  | {
      kind: "subscription.updated";
      subscriptionId: string;
      userId: string;
      projectId: string | null;
      entryId: string;
      customerId: string;
      status: "active" | "past_due" | "cancelled" | "trialing";
      creditsPerPeriod: string;
      periodStart: string;
      periodEnd: string;
      cancelAtPeriodEnd: boolean;
    }
  | { kind: "ignored"; eventType: string };

export interface PaymentProvider {
  status(): PaymentProviderStatus;
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSessionResult>;
  verifyWebhook(input: { payload: string; signature: string | null }): Promise<PaymentWebhookEvent>;
}
