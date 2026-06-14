import type { PaymentProvider, PaymentWebhookEvent } from "../../ports/payment-provider.js";

function checkoutFromData(data: Record<string, unknown>): PaymentWebhookEvent {
  return {
    kind: "checkout.completed",
    sessionId: String(data.sessionId ?? data.id ?? `fake_cs_${crypto.randomUUID()}`),
    userId: String(data.userId),
    projectId: typeof data.projectId === "string" ? data.projectId : null,
    entryId: String(data.entryId ?? data.productId),
    customerId: typeof data.customerId === "string" ? data.customerId : null,
    subscriptionId: typeof data.subscriptionId === "string" ? data.subscriptionId : null,
    periodStart: typeof data.periodStart === "string" ? data.periodStart : null,
    periodEnd: typeof data.periodEnd === "string" ? data.periodEnd : null,
  };
}

function subscriptionUpdatedFromData(data: Record<string, unknown>): PaymentWebhookEvent {
  return {
    kind: "subscription.updated",
    subscriptionId: String(data.subscriptionId),
    userId: String(data.userId),
    projectId: typeof data.projectId === "string" ? data.projectId : null,
    entryId: String(data.entryId),
    customerId: String(data.customerId),
    status:
      data.status === "past_due" ||
      data.status === "cancelled" ||
      data.status === "trialing" ||
      data.status === "active"
        ? data.status
        : "active",
    creditsPerPeriod: String(data.creditsPerPeriod ?? data.millicredits ?? "0"),
    periodStart: String(data.periodStart),
    periodEnd: String(data.periodEnd),
    cancelAtPeriodEnd: Boolean(data.cancelAtPeriodEnd),
  };
}

export function createFakePaymentProvider(): PaymentProvider {
  return {
    status() {
      return {
        mode: "fake",
        needsCredentials: true,
        message: "Stripe credentials are not configured; fake checkout is active for dev/test.",
      };
    },

    async createCheckoutSession(input) {
      const id = `fake_cs_${crypto.randomUUID()}`;
      const url = new URL(input.successUrl);
      url.searchParams.set("checkout", "fake");
      url.searchParams.set("session_id", id);
      url.searchParams.set("product", input.entry.id);
      return { id, url: url.toString(), mode: "fake", needsCredentials: true };
    },

    async verifyWebhook(input) {
      const parsed = JSON.parse(input.payload || "{}") as Record<string, unknown>;
      const eventType = typeof parsed.type === "string" ? parsed.type : null;
      if (eventType && eventType !== "checkout.session.completed" && eventType !== "invoice.paid") {
        if (
          eventType === "customer.subscription.updated" ||
          eventType === "customer.subscription.deleted"
        ) {
          const data = (
            parsed.data && typeof parsed.data === "object" ? parsed.data : parsed
          ) as Record<string, unknown>;
          const normalized = subscriptionUpdatedFromData(data);
          if (eventType === "customer.subscription.deleted") {
            return { ...normalized, status: "cancelled" };
          }
          return normalized;
        }
        return { kind: "ignored", eventType };
      }

      const data = (
        parsed.data && typeof parsed.data === "object" ? parsed.data : parsed
      ) as Record<string, unknown>;
      return checkoutFromData(data);
    },
  };
}
