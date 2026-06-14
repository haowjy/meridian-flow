export type SubscriptionPlan = "pro";
export type SubscriptionStatus = "active" | "past_due" | "cancelled" | "trialing";

export interface SubscriptionUpsertInput {
  userId: string;
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  creditsPerPeriod: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd?: boolean;
}

export interface SubscriptionRecord extends SubscriptionUpsertInput {
  id: string;
}

export interface SubscriptionStore {
  upsert(input: SubscriptionUpsertInput): Promise<SubscriptionRecord>;
  getByStripeSubscriptionId(stripeSubscriptionId: string): Promise<SubscriptionRecord | null>;
}
