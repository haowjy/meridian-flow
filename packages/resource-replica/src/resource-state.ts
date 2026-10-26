/** Pure resource creation, placement, and conflict-remint decisions. */
import { assertAvailabilityGeneration, storedFilename } from "@meridian/contracts/protocol";
import { newerCanonicalObservation } from "./canonical-observation";
import {
  awaitsWriterRepair,
  createAwaitsRemint,
  owningLocationIntent,
  supersedeRepairableNamespaceWork,
} from "./resource-intent-policy";
import type {
  NamespaceIntent,
  PlacementAdmission,
  ResourceDescriptor,
  ResourceDestination,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";

function nextSequence(record: ResourceRecord): number {
  return Math.max(0, ...record.intents.map((intent) => intent.sequence)) + 1;
}

export function reserveResourceDocument(input: {
  projectId: string;
  handle: string;
  documentId: string;
  databaseName: string;
  schema: string;
  intentId: string;
  folderPath?: string;
  provisionalName?: string;
  /** A named create is dispatchable at once: the writer chose where it goes. */
  destination?: { value: ResourceDestination; eligibleAt: number };
  admission?: PlacementAdmission;
}): ResourceWrite {
  const resource: ResourceDescriptor = {
    handle: input.handle,
    revision: 1,
    identity: { documentId: input.documentId, revision: 1 },
    content: {
      kind: "exact",
      databaseName: input.databaseName,
      schema: input.schema,
      initialization: "reserved",
    },
    classification: { editable: true, filetype: "markdown", schemaType: "document" },
    canonical: null,
    lifecycle: { kind: "local" },
    aliases: {},
    obligations: { createEligibility: { eligibleAt: input.destination?.eligibleAt ?? null } },
  };
  const intent: NamespaceIntent = {
    projectId: input.projectId,
    handle: input.handle,
    intentId: input.intentId,
    sequence: 1,
    ...(input.admission ? { admission: input.admission } : {}),
    identityRevision: 1,
    desired: {
      kind: "create",
      folderPath: input.folderPath ?? "",
      ...(input.provisionalName ? { provisionalName: input.provisionalName } : {}),
      ...(input.destination ? { destination: input.destination.value } : {}),
    },
    attempts: [],
    state: "pending",
  };
  return { expectedRevision: null, next: { resource, intents: [intent] } };
}

/** First content or explicit filing makes the already-durable Create intent dispatchable. */
export function markResourceCreateEligible(
  record: ResourceRecord,
  eligibleAt: number,
): ResourceWrite | null {
  if (!Number.isFinite(eligibleAt) || eligibleAt < 0)
    throw new Error("Resource create eligibility time is invalid");
  const eligibility = record.resource.obligations.createEligibility;
  if (!eligibility || eligibility.eligibleAt !== null) return null;
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        obligations: {
          ...record.resource.obligations,
          createEligibility: { eligibleAt },
        },
      },
      intents: record.intents,
    },
  };
}

/**
 * Where the writer puts a document. One the server never accepted (its create was refused) has
 * nothing to move: the placement becomes a new create under the same id, at the picked destination.
 */
export function planResourceLocation(input: {
  record: ResourceRecord;
  projectId: string;
  intentId: string;
  eligibleAt: number;
  admission?: PlacementAdmission;
  operationId?: string;
  destination: ResourceDestination;
  typedName?: string;
}): ResourceWrite | null {
  const { record } = input;
  if (record.resource.lifecycle.kind === "terminal") return null;
  const latest = owningLocationIntent(
    input.projectId,
    record.intents,
    Boolean(record.resource.obligations.canonicalRefresh),
  );
  // Compute the optimistic name once, retaining the input for server dispatch.
  const stored = storedFilename(
    input.destination.name,
    latest?.desired.kind === "set-location"
      ? latest.desired.destination.name
      : record.resource.canonical?.name,
  );
  const destination = stored.ok ? { ...input.destination, name: stored.name } : input.destination;
  const superseded = supersedeRepairableNamespaceWork(record, input.projectId);
  // A position reads the list as the placements before it left it, so the same words after other
  // placements are a different command; only a plain destination can be a duplicate.
  if (
    !superseded.repaired &&
    !destination.position &&
    latest?.desired.kind === "set-location" &&
    latest.state === "pending" &&
    latest.desired.typedName === (input.typedName ?? input.destination.name) &&
    JSON.stringify(latest.desired.destination) === JSON.stringify(destination)
  )
    return null;
  const refusedCreate = record.intents.some(
    (intent) =>
      intent.projectId === input.projectId &&
      intent.desired.kind === "create" &&
      awaitsWriterRepair(intent),
  );
  const intent: NamespaceIntent = {
    projectId: input.projectId,
    handle: record.resource.handle,
    intentId: input.intentId,
    sequence: nextSequence(record),
    ...(input.admission ? { admission: input.admission } : {}),
    identityRevision: record.resource.identity.revision,
    desired: refusedCreate
      ? { kind: "create", folderPath: "", provisionalName: destination.name, destination }
      : {
          kind: "set-location",
          typedName: input.typedName ?? input.destination.name,
          destination,
        },
    ...(input.operationId ? { operationId: input.operationId } : {}),
    attempts: [],
    state: "pending",
  };
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        obligations: record.resource.obligations.createEligibility
          ? {
              ...record.resource.obligations,
              createEligibility: {
                eligibleAt:
                  record.resource.obligations.createEligibility.eligibleAt ?? input.eligibleAt,
              },
            }
          : record.resource.obligations,
      },
      intents: [...superseded.intents, intent],
    },
  };
}

/** A recorded create conflict owns its old identity; remint preserves content and history. */
export function remintCreateConflict(input: {
  record: ResourceRecord;
  documentId: string;
  retryIntentId: string;
  rebasedIntentIds: Readonly<Record<string, string>>;
}): ResourceWrite | null {
  const { record } = input;
  const conflicted = [...record.intents]
    .sort((left, right) => right.sequence - left.sequence)
    .find((intent) => intent.desired.kind === "create" && createAwaitsRemint(intent));
  if (
    !conflicted ||
    record.resource.lifecycle.kind !== "local" ||
    record.resource.canonical !== null
  )
    return null;
  const oldDocumentId = record.resource.identity.documentId;
  if (oldDocumentId === input.documentId)
    throw new Error("Remint requires a new document identity");
  const identityRevision = record.resource.identity.revision + 1;
  const dependents = record.intents.filter(
    (intent) =>
      intent.sequence > conflicted.sequence &&
      intent.identityRevision === conflicted.identityRevision &&
      intent.state === "pending" &&
      intent.attempts.length === 0,
  );
  for (const dependent of dependents) {
    if (!input.rebasedIntentIds[dependent.intentId])
      throw new Error("Remint requires an identity for every dependent intention");
  }
  const retry: NamespaceIntent = {
    projectId: conflicted.projectId,
    handle: record.resource.handle,
    intentId: input.retryIntentId,
    sequence: nextSequence(record),
    identityRevision,
    desired: conflicted.desired,
    // The retry stands where the conflicted create stood in the account's causal order.
    ...(conflicted.admission ? { admission: conflicted.admission } : {}),
    attempts: [],
    state: "pending",
  };
  let sequence = retry.sequence;
  const rebased = dependents.map(
    (intent): NamespaceIntent => ({
      ...intent,
      intentId: input.rebasedIntentIds[intent.intentId] as string,
      sequence: ++sequence,
      identityRevision,
    }),
  );
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        identity: { documentId: input.documentId, revision: identityRevision },
        aliases: {
          ...record.resource.aliases,
          [oldDocumentId]: {
            introducedAtIdentityRevision: identityRevision,
          },
        },
      },
      intents: [
        ...record.intents.map((intent) => {
          if (intent.intentId === conflicted.intentId)
            return { ...intent, state: "superseded" as const };
          if (dependents.some((dependent) => dependent.intentId === intent.intentId))
            return { ...intent, state: "cancelled" as const };
          return intent;
        }),
        retry,
        ...rebased,
      ],
    },
  };
}

/** A cached acknowledged session can render locally before fresh remote admission completes. */
export function planCachedSessionAdoption(input: {
  record: ResourceRecord;
  projectId: string;
  transitionId: string;
}): ResourceWrite | null {
  const { record } = input;
  if (
    record.resource.lifecycle.kind !== "acknowledged" ||
    record.resource.content.kind !== "exact" ||
    record.resource.content.initialization === "reserved" ||
    record.resource.obligations.sessionAdoption
  )
    return null;
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        obligations: {
          ...record.resource.obligations,
          sessionAdoption: {
            transitionId: input.transitionId,
            projectId: input.projectId,
            documentId: record.resource.identity.documentId,
            identityRevision: record.resource.identity.revision,
            exactDatabaseName: record.resource.content.databaseName,
          },
        },
      },
      intents: record.intents,
    },
  };
}

/** Settles the obligation; `generation` is the committed incarnation's, the one the resource now carries. */
export function acknowledgeSessionAdoption(
  record: ResourceRecord,
  generation: string,
): ResourceWrite | null {
  assertAvailabilityGeneration(generation);
  if (!record.resource.obligations.sessionAdoption) return null;
  if (record.resource.lifecycle.kind !== "acknowledged") return null;
  const { sessionAdoption: _completed, ...obligations } = record.resource.obligations;
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        lifecycle: {
          kind: "acknowledged",
          availabilityGeneration: generation,
        },
        obligations,
      },
      intents: record.intents,
    },
  };
}

/** Record content proven by a live server session without fabricating an empty cache. */
export function recordAcquiredResourceContent(input: {
  record: ResourceRecord;
  projectId: string;
  documentId: string;
  databaseName: string;
  schema: string;
  generation: string;
  transitionId: string;
}): ResourceWrite | null {
  assertAvailabilityGeneration(input.generation);
  const { record } = input;
  if (supersededTerminal(record, input.generation)) return null;
  if (record.resource.identity.documentId !== input.documentId)
    throw new Error("Acquired content does not match the current resource identity");
  if (record.resource.lifecycle.kind !== "acknowledged") return null;
  if (record.resource.obligations.sessionAdoption) return null;
  if (
    record.resource.content.kind === "exact" &&
    record.resource.content.databaseName === input.databaseName &&
    record.resource.lifecycle.availabilityGeneration === input.generation
  )
    return null;
  if (
    record.resource.content.kind === "exact" &&
    record.resource.content.databaseName !== input.databaseName
  )
    throw new Error("Acquired resource content changed exact persistence");
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        content: {
          kind: "exact",
          databaseName: input.databaseName,
          schema: input.schema,
        },
        lifecycle: {
          kind: "acknowledged",
          availabilityGeneration: input.generation,
        },
        obligations: {
          ...record.resource.obligations,
          sessionAdoption: {
            transitionId: input.transitionId,
            projectId: input.projectId,
            documentId: record.resource.identity.documentId,
            identityRevision: record.resource.identity.revision,
            exactDatabaseName: input.databaseName,
          },
        },
      },
      intents: record.intents,
    },
  };
}

/**
 * A newer server observation already restored this document past the deletion generation; the
 * deleted lineage's purge still runs against its old exact database, but the descriptor stays.
 */
function supersededTerminal(record: ResourceRecord, generation: string): boolean {
  const revived = record.resource.revivedFrom;
  return (
    record.resource.lifecycle.kind !== "terminal" &&
    revived !== undefined &&
    BigInt(generation) <= BigInt(revived.generation)
  );
}

/** The highest server version known to prove this deletion; null leaves the terminal versionless. */
function terminalDeletionVersion(
  record: ResourceRecord,
  deletionVersion: string | null,
): string | undefined {
  const lifecycle = record.resource.lifecycle;
  const versions = [
    deletionVersion,
    lifecycle.kind === "terminal" ? lifecycle.deletionVersion : undefined,
  ].filter((version): version is string => typeof version === "string");
  if (versions.length === 0) return undefined;
  return versions.reduce((highest, version) =>
    newerCanonicalObservation(version, highest) ? version : highest,
  );
}

/**
 * The editor's exact-ID terminal. `deletionVersion` is the namespace version of the exact-ID
 * deletion evidence; the terminal holds it so stale catalog history can never revive it.
 */
export function publishResourceTerminal(input: {
  record: ResourceRecord;
  documentId: string;
  generation: string;
  transitionId: string;
  exactDatabaseName: string;
  deletionVersion: string | null;
}): ResourceWrite | null {
  assertAvailabilityGeneration(input.generation);
  const { record } = input;
  const deletionVersion = terminalDeletionVersion(record, input.deletionVersion);
  if (supersededTerminal(record, input.generation)) return null;
  if (
    record.resource.identity.documentId !== input.documentId ||
    record.resource.content.kind !== "exact" ||
    record.resource.content.databaseName !== input.exactDatabaseName
  ) {
    throw new Error("Terminal transition does not match exact resource content");
  }
  if (record.resource.lifecycle.kind === "terminal") {
    if (record.resource.lifecycle.generation !== input.generation) {
      throw new Error("Terminal resource belongs to another transition");
    }
    const cleanup = record.resource.obligations.cleanup;
    if (
      record.resource.lifecycle.transitionId === input.transitionId &&
      cleanup?.obligationId === input.transitionId &&
      cleanup.exactDatabaseName === input.exactDatabaseName
    )
      return null;
    if (cleanup) throw new Error("Terminal resource belongs to another transition");
    return {
      expectedRevision: record.resource.revision,
      next: {
        resource: {
          ...record.resource,
          revision: record.resource.revision + 1,
          lifecycle: {
            kind: "terminal",
            generation: input.generation,
            transitionId: input.transitionId,
            ...(deletionVersion === undefined ? {} : { deletionVersion }),
          },
          obligations: {
            ...record.resource.obligations,
            cleanup: {
              obligationId: input.transitionId,
              exactDatabaseName: input.exactDatabaseName,
            },
          },
        },
        intents: record.intents,
      },
    };
  }
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        canonical: null,
        lifecycle: {
          kind: "terminal",
          generation: input.generation,
          transitionId: input.transitionId,
          ...(deletionVersion === undefined ? {} : { deletionVersion }),
        },
        obligations: {
          cleanup: {
            obligationId: input.transitionId,
            exactDatabaseName: input.exactDatabaseName,
          },
        },
      },
      intents: record.intents,
    },
  };
}

export function acknowledgeResourceTerminalCleanup(input: {
  record: ResourceRecord;
  generation: string;
  transitionId: string;
  exactDatabaseName: string;
}): ResourceWrite | null {
  const { record } = input;
  if (supersededTerminal(record, input.generation)) return null;
  if (
    record.resource.lifecycle.kind !== "terminal" ||
    record.resource.lifecycle.generation !== input.generation ||
    record.resource.lifecycle.transitionId !== input.transitionId
  ) {
    throw new Error("Terminal cleanup belongs to another transition");
  }
  const cleanup = record.resource.obligations.cleanup;
  if (!cleanup) return null;
  if (
    cleanup.obligationId !== input.transitionId ||
    cleanup.exactDatabaseName !== input.exactDatabaseName
  ) {
    throw new Error("Terminal cleanup witness changed");
  }
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        obligations: {},
      },
      intents: record.intents,
    },
  };
}

export function acknowledgeLocalResourceCleanup(input: {
  record: ResourceRecord;
  transitionId: string;
  exactDatabaseName: string;
}): ResourceWrite | null {
  const { record } = input;
  const deletion = record.intents.find(
    (intent) =>
      intent.intentId === input.transitionId &&
      intent.desired.kind === "delete" &&
      intent.state === "settled-locally",
  );
  if (!deletion || record.resource.lifecycle.kind !== "local")
    throw new Error("Local cleanup belongs to another deletion");
  const cleanup = record.resource.obligations.cleanup;
  if (!cleanup) return null;
  if (
    cleanup.obligationId !== input.transitionId ||
    cleanup.exactDatabaseName !== input.exactDatabaseName
  )
    throw new Error("Local cleanup witness changed");
  const { cleanup: _cleanup, ...obligations } = record.resource.obligations;
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        obligations,
      },
      intents: record.intents,
    },
  };
}
