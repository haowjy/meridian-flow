/**
 * The device's side of a join: its instant create landed on a document that already existed.
 *
 * A draft's new document is a real document, hidden live only because it is a draft; creating
 * it live unhides it, and its draft stays an ordinary draft over it. The device made its own id
 * for the instant create, so the only work here is identity. The reservation's id becomes the
 * joined id, the handle stays, the old id becomes an alias, queued intents are rebased, and the
 * session-adoption witness sends what the writer typed to the joined room. No draft text is
 * merged: the document's live state is empty until Apply. Two records are never folded: if
 * another record already holds the joined id, the reservation is reminted like a create
 * conflict.
 */
import type { CatalogFileClassification } from "@meridian/contracts/protocol";
import { settleNamespaceIntent } from "./namespace-journal-policy";
import type {
  NamespaceIntent,
  ParentRef,
  ResourceLocation,
  ResourceRecord,
  ResourceWrite,
} from "./resource-records";

/** What the join target looks like from whichever trigger arrived first. */
export type JoinTarget = Readonly<{
  documentId: string;
  /** Null when the trigger cannot name the location yet; the catalog observation fills it. */
  location: ResourceLocation | null;
  parent?: ParentRef;
  classification?: CatalogFileClassification;
  observationVersion?: string;
}>;

type JoinedCreate = {
  intent: NamespaceIntent;
  attemptId: string;
  /** The document the server answered, absent when the catalog entry arrived first. */
  answered: string | null;
  requestedId: string;
};

function activeCreate(record: ResourceRecord): NamespaceIntent | null {
  return (
    [...record.intents]
      .sort((left, right) => right.sequence - left.sequence)
      .find(
        (intent) =>
          intent.desired.kind === "create" &&
          intent.state !== "cancelled" &&
          intent.state !== "superseded",
      ) ?? null
  );
}

function submittedCreate(record: ResourceRecord): JoinedCreate | null {
  const intent = activeCreate(record);
  const attempt = intent?.attempts.at(-1);
  if (!intent || !attempt || attempt.request.kind !== "create") return null;
  const outcome = attempt.outcome;
  return {
    intent,
    attemptId: attempt.attemptId,
    answered:
      outcome?.kind === "create" && outcome.result.status === "joined"
        ? outcome.result.documentId
        : null,
    requestedId: attempt.request.body.documentId,
  };
}

/** The joined document a received `joined` answer names, while the reservation has not yet followed it. */
export function pendingJoinTarget(record: ResourceRecord): JoinTarget | null {
  const create = submittedCreate(record);
  const attempt = create?.intent.attempts.at(-1);
  const outcome = attempt?.outcome;
  if (
    !create?.answered ||
    create.intent.state !== "received" ||
    outcome?.kind !== "create" ||
    outcome.result.status !== "joined" ||
    record.resource.identity.documentId !== create.requestedId
  )
    return null;
  const { address } = outcome.result;
  return {
    documentId: outcome.result.documentId,
    // A Work-scoped address waits for the catalog observation, which carries the Work's handle.
    location: address.workId
      ? null
      : {
          scheme: address.scheme,
          path: `/${address.path.replace(/^\/+/, "")}`,
          name: address.name,
          workId: null,
        },
  };
}

/** Whether this record's create already followed a join to `documentId`. */
export function followedJoin(record: ResourceRecord, requestedId: string, documentId: string) {
  return (
    record.resource.identity.documentId === documentId &&
    record.resource.aliases[requestedId] !== undefined
  );
}

/** Deterministic, so two tabs that rebase the same intent write the same record. */
function rebasedIntentId(intentId: string, identityRevision: number): string {
  return `${intentId}@${identityRevision}`;
}

/**
 * Re-identify a local reservation as `target`. Returns null when the record cannot join (not a
 * submitted local reservation, or already there). The caller has checked that no other record
 * holds `target.documentId`.
 */
export function joinReservation(input: {
  record: ResourceRecord;
  target: JoinTarget;
  settledAt: number;
}): ResourceWrite | null {
  const { record, target } = input;
  const { resource } = record;
  const create = submittedCreate(record);
  if (
    !create ||
    resource.lifecycle.kind !== "local" ||
    resource.canonical !== null ||
    resource.content.kind !== "exact" ||
    resource.content.initialization === "reserved" ||
    resource.identity.documentId !== create.requestedId ||
    resource.identity.documentId === target.documentId
  )
    return null;
  const identityRevision = resource.identity.revision + 1;
  const { createEligibility: _eligible, ...obligations } = resource.obligations;
  // The create settles with its answer; without one it stays submitted and its replay finds the
  // joined id forwarded, which settles it as already done.
  const answered = create.answered === target.documentId;
  const dependents = record.intents.filter(
    (intent) =>
      intent.sequence > create.intent.sequence &&
      intent.identityRevision === resource.identity.revision &&
      intent.state === "pending" &&
      intent.attempts.length === 0,
  );
  let sequence = Math.max(...record.intents.map((intent) => intent.sequence));
  const rebased = dependents.map(
    (intent): NamespaceIntent => ({
      ...intent,
      intentId: rebasedIntentId(intent.intentId, identityRevision),
      sequence: ++sequence,
      identityRevision,
    }),
  );
  const settled = answered
    ? settleNamespaceIntent(record.intents, create.intent, "accepted", input.settledAt)
    : record.intents;
  return {
    expectedRevision: resource.revision,
    next: {
      resource: {
        ...resource,
        revision: resource.revision + 1,
        identity: { documentId: target.documentId, revision: identityRevision },
        aliases: {
          ...resource.aliases,
          [resource.identity.documentId]: { introducedAtIdentityRevision: identityRevision },
        },
        lifecycle: { kind: "acknowledged", availabilityGeneration: null },
        ...(target.classification ? { classification: target.classification } : {}),
        canonical: target.location,
        ...(target.parent ? { canonicalParent: target.parent } : {}),
        ...(target.observationVersion ? { observationVersion: target.observationVersion } : {}),
        obligations: {
          ...obligations,
          sessionAdoption: {
            transitionId: create.attemptId,
            projectId: create.intent.projectId,
            documentId: target.documentId,
            identityRevision,
            exactDatabaseName: resource.content.databaseName,
          },
        },
      },
      intents: [
        ...settled.map((intent) =>
          dependents.some((dependent) => dependent.intentId === intent.intentId)
            ? { ...intent, state: "cancelled" as const }
            : intent,
        ),
        ...rebased,
      ],
    },
  };
}
