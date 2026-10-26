/** Latest writer commands supersede repair blockers and safe queued namespace work. */
import { newerCanonicalObservation } from "./canonical-observation";
import type { NamespaceIntent, ResourceDestination, ResourceRecord } from "./resource-records";

/**
 * Who repairs a failed placement. A materialization the server answered `conflict` or `joined` is
 * the runner's: the answer is about the id, so it materializes under a new one (`remintCreateConflict`).
 * Every other failure is the writer's: the server answered about the request, and only the writer
 * can change it. Answered for a recorded outcome, before or after its settlement.
 */
export type NamespaceRepairOwner = "remint" | "writer";

export function namespaceRepairOwner(intent: NamespaceIntent): NamespaceRepairOwner | null {
  if (intent.state !== "received" && intent.state !== "needs-repair") return null;
  const outcome = intent.attempts.at(-1)?.outcome;
  return outcome?.kind === "create" &&
    (outcome.result.status === "conflict" || outcome.result.status === "joined")
    ? "remint"
    : "writer";
}

/** A settled failure only the writer can repair: a refused placement or delete. */
export function awaitsWriterRepair(intent: NamespaceIntent): boolean {
  return intent.state === "needs-repair" && namespaceRepairOwner(intent) === "writer";
}

/** Work that can make progress without a new metadata revision. */
export function resourceNeedsBackgroundReconciliation(record: ResourceRecord): boolean {
  if (record.resource.obligations.sessionAdoption || record.resource.obligations.cleanup)
    return true;
  return record.intents.some(
    (intent) =>
      intent.state === "pending" ||
      intent.state === "submitted" ||
      intent.state === "received" ||
      namespaceRepairOwner(intent) === "remint",
  );
}

/**
 * The writer's next placement or delete retires what failed before it: each failed intent
 * (a refused placement too) is superseded and unsent work queued behind it is cancelled. A create
 * the runner will remint is left alone.
 */
export function supersedeRepairableNamespaceWork(
  record: Pick<ResourceRecord, "intents">,
  projectId: string | null,
): { intents: NamespaceIntent[]; repaired: boolean } {
  const inScope = (intent: NamespaceIntent) => projectId === null || intent.projectId === projectId;
  const failed = (intent: NamespaceIntent) => inScope(intent) && awaitsWriterRepair(intent);
  if (!record.intents.some(failed)) return { intents: [...record.intents], repaired: false };
  return {
    repaired: true,
    intents: record.intents.map((intent) => {
      if (failed(intent)) return { ...intent, state: "superseded" };
      if (inScope(intent) && intent.state === "pending" && intent.attempts.length === 0)
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

/** The server namespace version at which an accepted deletion was confirmed. */
export function confirmedDeletionVersion(intent: NamespaceIntent): string | undefined {
  if (intent.desired.kind !== "delete" || intent.state !== "settled") return undefined;
  const outcome = intent.attempts.at(-1)?.outcome;
  return outcome?.kind === "operation" ? outcome.receipt.observationVersion : undefined;
}

/**
 * Deletion ownership against the identity's held server observation. An accepted deletion
 * owns it only until a strictly newer server observation shows the identity present again
 * (a later restore wins); pending and local deletions always own it.
 */
export function intentOwnsDeletionAt(
  intent: NamespaceIntent,
  observationVersion: string | undefined,
): boolean {
  if (!intentOwnsDeletion(intent)) return false;
  const confirmed = confirmedDeletionVersion(intent);
  return (
    confirmed === undefined ||
    observationVersion === undefined ||
    !newerCanonicalObservation(observationVersion, confirmed)
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
 * Where the writer put the document and the record still shows it: an owning placement's
 * destination. A document the server has not materialized yet may have no destination (the
 * editor's nameless create), so this answers undefined and the projection's base location shows.
 */
export function placementDestination(
  projectId: string | null,
  record: ResourceRecord,
): ResourceDestination | undefined {
  const owner = owningLocationIntent(
    projectId,
    record.intents,
    Boolean(record.resource.obligations.canonicalRefresh),
  )?.desired;
  return owner?.kind === "set-location" ? owner.destination : undefined;
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
