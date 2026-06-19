import { classifyActiveSibling, isMonotonicReplacement } from "../../domain/subscription-policy.js";
import type {
  SubscriptionRecord,
  SubscriptionStore,
  SubscriptionUpsertInput,
} from "../../ports/subscription-store.js";

export function createInMemorySubscriptionStore(
  initial: SubscriptionRecord[] = [],
): SubscriptionStore {
  const records = new Map<string, SubscriptionRecord>(
    initial.map((record) => [record.stripeSubscriptionId, record]),
  );

  return {
    async upsert(input: SubscriptionUpsertInput) {
      const existing = records.get(input.stripeSubscriptionId) ?? null;
      if (existing && !isMonotonicReplacement(existing, input)) {
        return existing;
      }

      const blocking = [...records.values()].find(
        (record) => classifyActiveSibling(record, input) === "blocks",
      );
      if (blocking) return blocking;

      for (const [key, record] of records.entries()) {
        if (classifyActiveSibling(record, input) === "cancel") {
          records.set(key, { ...record, status: "cancelled" });
        }
      }

      const next: SubscriptionRecord = {
        id: existing?.id ?? crypto.randomUUID(),
        ...input,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      };
      records.set(input.stripeSubscriptionId, next);
      return next;
    },

    async getByStripeSubscriptionId(stripeSubscriptionId) {
      return records.get(stripeSubscriptionId) ?? null;
    },
  };
}
