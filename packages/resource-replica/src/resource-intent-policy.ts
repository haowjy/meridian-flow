/** Latest writer commands supersede repair blockers and safe queued namespace work. */
import type { NamespaceIntent, ResourceRecord } from "./resource-records";

/** Work that can make progress without a new metadata revision. */
export function resourceNeedsBackgroundReconciliation(record: ResourceRecord): boolean {
  if (record.resource.obligations.sessionAdoption || record.resource.obligations.cleanup)
    return true;
  return record.intents.some(
    (intent) =>
      intent.state === "pending" ||
      intent.state === "submitted" ||
      intent.state === "received" ||
      (intent.state === "needs-repair" && intent.desired.kind === "create"),
  );
}

export function supersedeRepairableNamespaceWork(
  record: ResourceRecord,
  projectId: string,
): { intents: NamespaceIntent[]; repaired: boolean } {
  const repaired = record.intents.some(
    (intent) =>
      intent.projectId === projectId &&
      intent.desired.kind !== "create" &&
      intent.state === "needs-repair",
  );
  if (!repaired) return { intents: [...record.intents], repaired: false };
  return {
    repaired: true,
    intents: record.intents.map((intent) => {
      if (intent.projectId !== projectId || intent.desired.kind === "create") return intent;
      if (intent.state === "needs-repair") return { ...intent, state: "settled" };
      if (intent.state === "pending" && intent.attempts.length === 0)
        return { ...intent, state: "cancelled" };
      return intent;
    }),
  };
}
