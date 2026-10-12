/** Local deletion records cleanup work; server-backed deletion still needs terminal authority. */

import { newerCanonicalObservation } from "./canonical-observation";
import { intentOwnsDeletionAt, supersedeRepairableNamespaceWork } from "./resource-intent-policy";
import type { NamespaceIntent, ResourceRecord, ResourceWrite } from "./resource-records";

export function planResourceDeletion(
  record: ResourceRecord,
  projectId: string,
  intentId: string,
): ResourceWrite | null {
  if (
    record.resource.lifecycle.kind === "terminal" ||
    record.intents.some((intent) =>
      intentOwnsDeletionAt(intent, record.resource.observationVersion),
    )
  )
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

/** Server-proven deletion from namespace receipts, never availability observations. */
export function committedResourceDeletion(
  resource: ResourceRecord["resource"],
  generation: string,
  transitionId: string,
  observationVersion: string,
): ResourceRecord["resource"] {
  if (!newerCanonicalObservation(observationVersion, resource.observationVersion)) return resource;
  const {
    sessionAdoption: _superseded,
    canonicalRefresh: _unexecutable,
    ...obligations
  } = resource.obligations;
  return {
    ...resource,
    canonical: null,
    observationVersion,
    obligations,
    lifecycle: { kind: "terminal", generation, transitionId },
  };
}
