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
      if (existing) {
        const existingStart = new Date(existing.currentPeriodStart).getTime();
        const inputStart = new Date(input.currentPeriodStart).getTime();
        if (
          (Number.isFinite(existingStart) &&
            Number.isFinite(inputStart) &&
            inputStart < existingStart) ||
          (inputStart === existingStart &&
            existing.status === "cancelled" &&
            input.status !== "cancelled")
        ) {
          return existing;
        }
      }
      const inputStart = new Date(input.currentPeriodStart).getTime();
      if (input.status !== "cancelled") {
        const newerActive = [...records.values()].find((record) => {
          const recordStart = new Date(record.currentPeriodStart).getTime();
          return (
            record.userId === input.userId &&
            record.stripeSubscriptionId !== input.stripeSubscriptionId &&
            record.status !== "cancelled" &&
            Number.isFinite(recordStart) &&
            Number.isFinite(inputStart) &&
            recordStart > inputStart
          );
        });
        if (newerActive) return newerActive;
      }

      for (const [key, record] of records.entries()) {
        const recordStart = new Date(record.currentPeriodStart).getTime();
        if (
          record.userId === input.userId &&
          record.status !== "cancelled" &&
          key !== input.stripeSubscriptionId &&
          (!Number.isFinite(recordStart) ||
            !Number.isFinite(inputStart) ||
            recordStart <= inputStart)
        ) {
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
