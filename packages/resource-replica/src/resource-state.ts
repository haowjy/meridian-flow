/** Pure resource creation, placement, and conflict-remint decisions. */
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
    canonical: null,
    lifecycle: { kind: "local" },
    aliases: {},
    obligations: {},
  };
  const intent: NamespaceIntent = {
    projectId: input.projectId,
    handle: input.handle,
    intentId: input.intentId,
    sequence: 1,
    identityRevision: 1,
    desired: { kind: "create", folderPath: input.folderPath ?? "" },
    attempts: [],
    state: "pending",
  };
  return { expectedRevision: null, next: { resource, intents: [intent] } };
}

export function planResourceLocation(input: {
  record: ResourceRecord;
  projectId: string;
  intentId: string;
  destination: Omit<ResourceLocation, "path"> & { folderPath: string };
}): ResourceWrite | null {
  const { record } = input;
  if (record.resource.lifecycle.kind === "terminal") return null;
  const latest = [...record.intents]
    .sort((left, right) => right.sequence - left.sequence)
    .find((intent) => intent.state !== "cancelled" && intent.state !== "settled-locally");
  if (
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
      resource: { ...record.resource, revision: record.resource.revision + 1 },
      intents: [...record.intents, intent],
    },
  };
}

/** A recorded create conflict owns its old identity; remint preserves content and history. */
export function remintCreateConflict(input: {
  record: ResourceRecord;
  documentId: string;
  retryIntentId: string;
  publicationObligationId: string;
}): ResourceWrite | null {
  const { record } = input;
  const conflicted = [...record.intents]
    .sort((left, right) => right.sequence - left.sequence)
    .find((intent) => intent.state === "received" && intent.desired.kind === "create");
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
            publicationObligationId: input.publicationObligationId,
            introducedAtIdentityRevision: identityRevision,
          },
        },
      },
      intents: [
        ...record.intents.map((intent) =>
          intent.intentId === conflicted.intentId
            ? { ...intent, state: "settled" as const }
            : intent,
        ),
        retry,
      ],
    },
  };
}

export function planSessionAdoptionGeneration(
  record: ResourceRecord,
  generation: string,
): ResourceWrite | null {
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

export function acknowledgeSessionAdoption(record: ResourceRecord): ResourceWrite | null {
  const adoption = record.resource.obligations.sessionAdoption;
  if (!adoption?.generation) return null;
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
