/** Local deletion records cleanup work; server-backed deletion still needs terminal authority. */

import { intentOwnsDeletion, supersedeRepairableNamespaceWork } from "./resource-intent-policy";
import type { NamespaceIntent, ResourceRecord, ResourceWrite } from "./resource-records";

export function planResourceDeletion(
  record: ResourceRecord,
  projectId: string,
  intentId: string,
): ResourceWrite | null {
  if (record.resource.lifecycle.kind === "terminal" || record.intents.some(intentOwnsDeletion))
    return null;
  const neverSubmitted =
    record.resource.lifecycle.kind === "local" &&
    record.resource.canonical === null &&
    record.intents.every((intent) => intent.attempts.length === 0);
  const superseded = supersedeRepairableNamespaceWork(record, projectId);
  const deletion: NamespaceIntent = {
    projectId,
    handle: record.resource.handle,
    intentId,
    sequence: Math.max(0, ...record.intents.map((intent) => intent.sequence)) + 1,
    identityRevision: record.resource.identity.revision,
    desired: { kind: "delete" },
    attempts: [],
    state: neverSubmitted ? "settled-locally" : "pending",
  };
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        ...(neverSubmitted && record.resource.content.kind === "exact"
          ? {
              obligations: {
                cleanup: {
                  obligationId: intentId,
                  exactDatabaseName: record.resource.content.databaseName,
                },
              },
            }
          : {}),
      },
      intents: [
        ...superseded.intents.map((intent) =>
          !superseded.repaired &&
          intent.attempts.length === 0 &&
          intent.state !== "cancelled" &&
          intent.state !== "superseded"
            ? { ...intent, state: "cancelled" as const }
            : intent,
        ),
        deletion,
      ],
    },
  };
}

/** A refused first placement has no accepted file to restore, only a server reservation. */
export function planRejectedReservationDeletion(
  record: ResourceRecord,
  intentId: string,
): ResourceWrite | null {
  if (record.resource.canonical?.scheme !== "unfiled") return null;
  const created = record.intents.some(
    (intent) => intent.desired.kind === "create" && intent.state === "settled",
  );
  const acceptedPlacement = record.intents.some(
    (intent) => intent.desired.kind === "set-location" && intent.state === "settled",
  );
  const failed = record.intents.find(
    (intent) =>
      intent.desired.kind === "set-location" &&
      intent.desired.initializesReservation === true &&
      intent.state === "needs-repair",
  );
  const outcome = failed?.attempts.at(-1)?.outcome;
  if (
    !created ||
    acceptedPlacement ||
    !failed ||
    !outcome ||
    outcome.kind === "create" ||
    (outcome.kind === "operation" && outcome.receipt.result.ok)
  )
    return null;
  return planResourceDeletion(record, failed.projectId, intentId);
}
