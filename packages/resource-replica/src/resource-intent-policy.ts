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
  projectId: string | null,
): { intents: NamespaceIntent[]; repaired: boolean } {
  const repaired = record.intents.some(
    (intent) =>
      (projectId === null || intent.projectId === projectId) &&
      intent.desired.kind !== "create" &&
      intent.state === "needs-repair",
  );
  if (!repaired) return { intents: [...record.intents], repaired: false };
  return {
    repaired: true,
    intents: record.intents.map((intent) => {
      if (
        (projectId !== null && intent.projectId !== projectId) ||
        intent.desired.kind === "create"
      )
        return intent;
      if (intent.state === "needs-repair") return { ...intent, state: "superseded" };
      if (intent.state === "pending" && intent.attempts.length === 0)
        return { ...intent, state: "cancelled" };
      return intent;
    }),
  };
}

/** Local deletion settlement owns deletion; rejected and superseded history never does. */
export function intentOwnsDeletion(intent: NamespaceIntent): boolean {
  return (
    intent.desired.kind === "delete" &&
    (intent.state === "pending" ||
      intent.state === "submitted" ||
      intent.state === "received" ||
      intent.state === "settled" ||
      intent.state === "settled-locally")
  );
}

/** Only active or accepted moves can own placement. */
export function intentOwnsLocation(intent: NamespaceIntent): boolean {
  return (
    (intent.desired.kind === "set-location" || intent.desired.kind === "set-folder-location") &&
    (intent.state === "pending" ||
      intent.state === "submitted" ||
      intent.state === "received" ||
      intent.state === "settled")
  );
}

/**
 * The placement the writer still sees from local intentions. A settled move owns it only
 * until a catalog read after its receipt installs the canonical location; from then on
 * the installed location is truth, so a later move of a parent by anyone cannot be
 * overridden by the stale destination this intention recorded.
 */
export function owningLocationIntent(
  projectId: string | null,
  intents: readonly NamespaceIntent[],
  canonicalRefreshPending: boolean,
): NamespaceIntent | null {
  const blocker = intents.find(
    (intent) =>
      (projectId === null || intent.projectId === projectId) && intent.state === "needs-repair",
  );
  const owner =
    [...intents]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (intent) =>
          (projectId === null || intent.projectId === projectId) &&
          (!blocker || intent.sequence < blocker.sequence) &&
          intentOwnsLocation(intent),
      ) ?? null;
  return owner?.state === "settled" && !canonicalRefreshPending ? null : owner;
}
