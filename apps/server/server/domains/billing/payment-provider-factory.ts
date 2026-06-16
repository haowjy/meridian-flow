import { createFakePaymentProvider } from "./adapters/fake/payment-provider.js";
import { createStripePaymentProvider, stripeReady } from "./adapters/stripe/payment-provider.js";
import type { PaymentProvider } from "./ports/payment-provider.js";

export function createPaymentProviderFromEnv(env: NodeJS.ProcessEnv): PaymentProvider {
  if (!stripeReady(env)) return createFakePaymentProvider();
  return createStripePaymentProvider({
    secretKey: env.STRIPE_SECRET_KEY as string,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET as string,
    env,
  });
}
