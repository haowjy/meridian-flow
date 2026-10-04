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
  record: Pick<ResourceRecord, "intents">,
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

/** Historical rejected deletes remain evidence, not deletion ownership after supersession. */
export function intentOwnsDeletion(intent: NamespaceIntent): boolean {
  if (intent.desired.kind !== "delete") return false;
  if (intent.state === "cancelled" || intent.state === "needs-repair") return false;
  const outcome = intent.attempts.at(-1)?.outcome;
  return !(
    intent.state === "settled" &&
    outcome?.kind === "operation" &&
    !outcome.receipt.result.ok
  );
}

/** Rejected history is evidence, never placement ownership after a retry supersedes it. */
export function intentOwnsLocation(intent: NamespaceIntent): boolean {
  if (intent.desired.kind !== "set-location" && intent.desired.kind !== "set-folder-location")
    return false;
  if (["cancelled", "settled-locally", "needs-repair"].includes(intent.state)) return false;
  const outcome = intent.attempts.at(-1)?.outcome;
  return !(
    intent.state === "settled" &&
    outcome?.kind === "operation" &&
    !outcome.receipt.result.ok
  );
}

export function owningLocationIntent(
  projectId: string,
  intents: readonly NamespaceIntent[],
): NamespaceIntent | null {
  return (
    [...intents]
      .sort((left, right) => right.sequence - left.sequence)
      .find((intent) => intent.projectId === projectId && intentOwnsLocation(intent)) ?? null
  );
}
