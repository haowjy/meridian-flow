/** Local deletion records cleanup work; server-backed deletion still needs terminal authority. */

import { newerCanonicalObservation } from "./canonical-observation";
import { resourceNeverAccepted } from "./namespace-journal-policy";
import { intentOwnsDeletionAt, supersedeRepairableNamespaceWork } from "./resource-intent-policy";
import type {
  NamespaceIntent,
  PlacementAdmission,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";

/** The exact content of a document the server never held is cleaned up once its deletion settles. */
function locallyDeleted(
  resource: ResourceRecord["resource"],
  deletionIntentId: string,
): ResourceRecord["resource"] {
  const next = { ...resource, revision: resource.revision + 1 };
  return resource.content.kind === "exact"
    ? {
        ...next,
        obligations: {
          cleanup: {
            obligationId: deletionIntentId,
            exactDatabaseName: resource.content.databaseName,
          },
        },
      }
    : next;
}

/** A queued delete of a document the server never accepted settles on this device. */
export function settleDeletionLocally(record: ResourceRecord, intentId: string): ResourceWrite {
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: locallyDeleted(record.resource, intentId),
      intents: record.intents.map((intent) =>
        intent.intentId === intentId ? { ...intent, state: "settled-locally" } : intent,
      ),
    },
  };
}

export function planResourceDeletion(
  record: ResourceRecord,
  projectId: string,
  intentId: string,
  operationId?: string,
  admission?: PlacementAdmission,
): ResourceWrite | null {
  if (
    record.resource.lifecycle.kind === "terminal" ||
    record.intents.some((intent) =>
      intentOwnsDeletionAt(intent, record.resource.observationVersion),
    )
  )
    return null;
  const neverAccepted = resourceNeverAccepted(record);
  const superseded = supersedeRepairableNamespaceWork(record, projectId);
  const deletion: NamespaceIntent = {
    projectId,
    handle: record.resource.handle,
    intentId,
    sequence: Math.max(0, ...record.intents.map((intent) => intent.sequence)) + 1,
    identityRevision: record.resource.identity.revision,
    desired: { kind: "delete" },
    ...(admission ? { admission } : {}),
    ...(operationId ? { operationId } : {}),
    attempts: [],
    state: neverAccepted ? "settled-locally" : "pending",
  };
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: neverAccepted
        ? locallyDeleted(record.resource, intentId)
        : { ...record.resource, revision: record.resource.revision + 1 },
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
  // An editor terminal may already hold newer exact-ID deletion evidence; keep the higher.
  const held =
    resource.lifecycle.kind === "terminal" ? resource.lifecycle.deletionVersion : undefined;
  const deletionVersion =
    held !== undefined && !newerCanonicalObservation(observationVersion, held)
      ? held
      : observationVersion;
  return {
    ...resource,
    canonical: null,
    observationVersion,
    obligations,
    lifecycle: { kind: "terminal", generation, transitionId, deletionVersion },
  };
}
