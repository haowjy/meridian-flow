/**
 * Stripe customer provisioning with compare-and-set persistence so concurrent
 * checkout starts converge on the one customer id that wins the user row race.
 */
import type { Database } from "@meridian/database";
import { users } from "@meridian/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import type { StripeBillingGateway } from "../stripe/stripe-gateway.js";

export function createStripeCustomerProvisioner(input: {
  db: Database;
  stripeGateway: StripeBillingGateway | null;
}): (userId: string) => Promise<string> {
  const { db, stripeGateway } = input;
  return async (userId: string) => {
    const [existing] = await db
      .select({ stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (existing?.stripeCustomerId) return existing.stripeCustomerId;
    if (!stripeGateway) throw new Error("Stripe checkout is not configured");

    const customer = await stripeGateway.createCustomer({ userId });
    await db
      .update(users)
      .set({ stripeCustomerId: customer.id, updatedAt: new Date().toISOString() })
      .where(and(eq(users.id, userId), isNull(users.stripeCustomerId)));

    const [winner] = await db
      .select({ stripeCustomerId: users.stripeCustomerId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!winner?.stripeCustomerId) throw new Error("Stripe customer creation did not persist");
    return winner.stripeCustomerId;
  };
}
