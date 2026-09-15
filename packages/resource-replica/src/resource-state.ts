/** Pure resource creation, placement, and conflict-remint decisions. */
import { assertAvailabilityGeneration } from "@meridian/contracts/protocol";
import { supersedeRepairableNamespaceWork } from "./resource-intent-policy";
import type {
  NamespaceIntent,
  ResourceDescriptor,
  ResourceLocation,
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
    obligations: { createEligibility: { eligibleAt: null } },
  };
  const intent: NamespaceIntent = {
    projectId: input.projectId,
    handle: input.handle,
    intentId: input.intentId,
    sequence: 1,
    identityRevision: 1,
    desired: {
      kind: "create",
      folderPath: input.folderPath ?? "",
      ...(input.provisionalName ? { provisionalName: input.provisionalName } : {}),
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

export function planResourceLocation(input: {
  record: ResourceRecord;
  projectId: string;
  intentId: string;
  eligibleAt: number;
  destination: Omit<ResourceLocation, "path"> & { folderPath: string };
}): ResourceWrite | null {
  const { record } = input;
  if (record.resource.lifecycle.kind === "terminal") return null;
  const latest = [...record.intents]
    .sort((left, right) => right.sequence - left.sequence)
    .find((intent) => intent.state !== "cancelled" && intent.state !== "settled-locally");
  const superseded = supersedeRepairableNamespaceWork(record, input.projectId);
  if (
    !superseded.repaired &&
    latest?.desired.kind === "set-location" &&
    latest.state === "pending" &&
    JSON.stringify(latest.desired.destination) === JSON.stringify(input.destination)
  )
    return null;
  const intent: NamespaceIntent = {
    projectId: input.projectId,
    handle: record.resource.handle,
    intentId: input.intentId,
    sequence: nextSequence(record),
    identityRevision: record.resource.identity.revision,
    desired: { kind: "set-location", destination: input.destination },
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
    .find(
      (intent) =>
        (intent.state === "received" || intent.state === "needs-repair") &&
        intent.desired.kind === "create",
    );
  const outcome = conflicted?.attempts.at(-1)?.outcome;
  if (
    !conflicted ||
    outcome?.kind !== "create" ||
    outcome.result.status !== "conflict" ||
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
            return { ...intent, state: "settled" as const };
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

export function planSessionAdoptionGeneration(
  record: ResourceRecord,
  generation: string,
): ResourceWrite | null {
  assertAvailabilityGeneration(generation);
  const adoption = record.resource.obligations.sessionAdoption;
  if (!adoption) return null;
  if (adoption.generation === generation) return null;
  if (adoption.generation !== null) throw new Error("Session adoption generation is immutable");
  return {
    expectedRevision: record.resource.revision,
    next: {
      resource: {
        ...record.resource,
        revision: record.resource.revision + 1,
        obligations: {
          ...record.resource.obligations,
          sessionAdoption: { ...adoption, generation },
        },
      },
      intents: record.intents,
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
            generation: null,
          },
        },
      },
      intents: record.intents,
    },
  };
}

export function acknowledgeSessionAdoption(record: ResourceRecord): ResourceWrite | null {
  const adoption = record.resource.obligations.sessionAdoption;
  if (!adoption || adoption.generation === null) return null;
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
          availabilityGeneration: adoption.generation,
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
            generation: input.generation,
          },
        },
      },
      intents: record.intents,
    },
  };
}

export function publishResourceTerminal(input: {
  record: ResourceRecord;
  documentId: string;
  generation: string;
  transitionId: string;
  exactDatabaseName: string;
}): ResourceWrite | null {
  assertAvailabilityGeneration(input.generation);
  const { record } = input;
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
