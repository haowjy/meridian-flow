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
 * and the document's create is sent again, since what the deletion cancelled cannot restart. Null
 * once the window has closed (the content may already be cleaned up) or when no such deletion is held.
 */
export function planLocalDeletionUndo(
  record: ResourceRecord,
  input: { operationId: string; createIntentId: string; now: number },
): ResourceWrite | null {
  const deletion = record.intents.find(
    (intent) =>
      intent.operationId === input.operationId &&
      intent.desired.kind === "delete" &&
      intent.state === "settled-locally",
  );
  const { cleanup, ...obligations } = record.resource.obligations;
  if (
    !deletion ||
    cleanup?.obligationId !== deletion.intentId ||
    (cleanup.notBefore !== undefined && input.now >= cleanup.notBefore)
  )
    return null;
  const create = record.intents
    .filter((intent) => intent.desired.kind === "create")
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (!create) return null;
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: { ...record.resource, revision: record.resource.revision + 1, obligations },
      intents: [
        ...record.intents.map((intent) =>
          intent === deletion ? { ...intent, state: "superseded" as const } : intent,
        ),
        {
          projectId: create.projectId,
          handle: record.resource.handle,
          intentId: input.createIntentId,
          sequence: Math.max(...record.intents.map((intent) => intent.sequence)) + 1,
          identityRevision: record.resource.identity.revision,
          desired: create.desired,
          ...(create.admission ? { admission: create.admission } : {}),
          attempts: [],
          state: "pending",
        },
      ],
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
