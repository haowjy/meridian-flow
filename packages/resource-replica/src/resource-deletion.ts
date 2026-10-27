/** Local deletion records cleanup work; server-backed deletion still needs terminal authority. */

import { newerCanonicalObservation } from "./canonical-observation";
import { undoLocalDeletion } from "./namespace-journal-policy";
import { intentOwnsDeletionAt, supersedeRepairableNamespaceWork } from "./resource-intent-policy";
import type {
  NamespaceIntent,
  PlacementAdmission,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";
import { deleteNeedsServer } from "./server-hold";

/**
 * How long a deleted document that exists only on this device can be brought back. The server
 * keeps its own deletions in Trash; this device has no Trash, so the exact content waits out the
 * window and is then cleaned up.
 */
export const LOCAL_DELETION_UNDO_MS = 10 * 60_000;

/** The exact content of a document the server never held is cleaned up once the Undo window closes. */
function locallyDeleted(
  resource: ResourceRecord["resource"],
  deletionIntentId: string,
  now: number,
): ResourceRecord["resource"] {
  const next = { ...resource, revision: resource.revision + 1 };
  return resource.content.kind === "exact"
    ? {
        ...next,
        obligations: {
          ...resource.obligations,
          cleanup: {
            obligationId: deletionIntentId,
            exactDatabaseName: resource.content.databaseName,
            notBefore: now + LOCAL_DELETION_UNDO_MS,
          },
        },
      }
    : next;
}

/** A queued delete of a document the server never accepted settles on this device. */
export function settleDeletionLocally(
  record: ResourceRecord,
  intentId: string,
  now = Date.now(),
): ResourceWrite {
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: locallyDeleted(record.resource, intentId, now),
      intents: record.intents.map((intent) =>
        intent.intentId === intentId ? { ...intent, state: "settled-locally" } : intent,
      ),
    },
  };
}

/**
 * Undo of a deletion that settled on this device, inside its window: the deletion is superseded
 * and the document's last placement is sent again, since what the deletion cancelled cannot restart.
 * Null once the window has closed (the content may already be cleaned up) or when no such
 * deletion is held.
 */
export function planLocalDeletionUndo(
  record: ResourceRecord,
  input: { operationId: string; createIntentId: string; now: number },
): ResourceWrite | null {
  const { cleanup, ...obligations } = record.resource.obligations;
  const intents = undoLocalDeletion({
    intents: record.intents,
    window: cleanup,
    operationId: input.operationId,
    createIntentId: input.createIntentId,
    identityRevision: record.resource.identity.revision,
    now: input.now,
  });
  if (!intents) return null;
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: { ...record.resource, revision: record.resource.revision + 1, obligations },
      intents,
    },
  };
}

export function planResourceDeletion(
  record: ResourceRecord,
  projectId: string,
  intentId: string,
  operationId?: string,
  admission?: PlacementAdmission,
  now = Date.now(),
): ResourceWrite | null {
  if (
    record.resource.lifecycle.kind === "terminal" ||
    record.intents.some((intent) =>
      intentOwnsDeletionAt(intent, record.resource.observationVersion),
    )
  )
    return null;
  const neverAccepted = !deleteNeedsServer(record.resource.serverHold);
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
        ? locallyDeleted(record.resource, intentId, now)
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
