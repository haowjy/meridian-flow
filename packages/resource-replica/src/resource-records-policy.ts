/** Journal invariants shared by storage adapters; attempts are immutable once submitted. */
import { validateNamespaceJournal } from "./namespace-journal-policy";
import type { ResourceRecord } from "./resource-records";

export function validateResourceRecordUpdate(
  previous: ResourceRecord | null,
  next: ResourceRecord,
): void {
  const resource = next.resource;
  if (next.intents.some((intent) => intent.desired.kind === "set-folder-location"))
    throw new Error("Folder placement requires a folder namespace record");
  if (resource.revision !== (previous?.resource.revision ?? 0) + 1)
    throw new Error("Invalid resource revision");
  if (previous && previous.resource.handle !== resource.handle)
    throw new Error("Resource identity mismatch");
  if (previous?.resource.lifecycle.kind === "terminal" && resource.lifecycle.kind !== "terminal")
    throw new Error("Terminal resources cannot be revived");
  const nextInitializationReserved =
    resource.content.kind === "exact" && resource.content.initialization === "reserved";
  const previousInitializationReserved =
    previous?.resource.content.kind === "exact" &&
    previous.resource.content.initialization === "reserved";
  if (previous && nextInitializationReserved && !previousInitializationReserved)
    throw new Error("Content initialization reservation cannot restart");
  if (nextInitializationReserved) {
    if (
      resource.lifecycle.kind !== "local" ||
      resource.canonical !== null ||
      next.intents.some((intent) => intent.attempts.length > 0)
    )
      throw new Error("Content initialization may only be reserved with a new local resource");
  }
  if (previousInitializationReserved && previous?.resource.content.kind === "exact") {
    if (
      resource.content.kind !== "exact" ||
      resource.content.databaseName !== previous.resource.content.databaseName ||
      resource.identity.documentId !== previous.resource.identity.documentId ||
      resource.identity.revision !== previous.resource.identity.revision
    )
      throw new Error("Reserved content identity cannot change before initialization");
  }
  const eligibility = resource.obligations.createEligibility;
  if (
    eligibility &&
    eligibility.eligibleAt !== null &&
    (!Number.isFinite(eligibility.eligibleAt) || eligibility.eligibleAt < 0)
  )
    throw new Error("Resource create eligibility is invalid");
  const executableCreate = next.intents.some(
    (intent) =>
      intent.desired.kind === "create" &&
      intent.state !== "cancelled" &&
      intent.state !== "settled" &&
      intent.state !== "settled-locally",
  );
  if (
    executableCreate &&
    resource.lifecycle.kind === "local" &&
    resource.canonical === null &&
    !eligibility
  )
    throw new Error("Local creation requires an explicit eligibility witness");
  const previousEligibility = previous?.resource.obligations.createEligibility;
  if (
    previousEligibility &&
    previousEligibility.eligibleAt !== null &&
    eligibility &&
    eligibility.eligibleAt !== previousEligibility?.eligibleAt
  )
    throw new Error("Resource create eligibility cannot be reset");
  if (
    resource.obligations.canonicalRefresh &&
    resource.obligations.canonicalRefresh.identityRevision !== resource.identity.revision
  )
    throw new Error("Canonical refresh belongs to another resource identity");
  const adoption = resource.obligations.sessionAdoption;
  if (
    adoption &&
    (resource.content.kind !== "exact" ||
      resource.content.initialization === "reserved" ||
      adoption.documentId !== resource.identity.documentId ||
      adoption.identityRevision !== resource.identity.revision ||
      adoption.exactDatabaseName !== resource.content.databaseName ||
      resource.lifecycle.kind !== "acknowledged")
  )
    throw new Error("Session adoption witness does not match the resource");
  if (adoption && previous && !previous.resource.obligations.sessionAdoption) {
    const source = next.intents.find(
      (intent) =>
        intent.projectId === adoption.projectId &&
        intent.identityRevision === adoption.identityRevision &&
        intent.attempts.some(
          (attempt) =>
            attempt.attemptId === adoption.transitionId &&
            attempt.request.kind === "create" &&
            attempt.outcome?.kind === "create" &&
            attempt.outcome.result.status !== "conflict",
        ),
    );
    const previousContent = previous?.resource.content;
    const sameAcknowledgedCache =
      previous?.resource.lifecycle.kind === "acknowledged" &&
      previous.resource.identity.documentId === adoption.documentId &&
      previous.resource.identity.revision === adoption.identityRevision &&
      previousContent?.kind === "exact" &&
      previousContent.initialization !== "reserved" &&
      previousContent.databaseName === adoption.exactDatabaseName &&
      !previous.intents.some((intent) =>
        intent.attempts.some((attempt) => attempt.attemptId === adoption.transitionId),
      );
    const acquiredServerCache =
      previous?.resource.lifecycle.kind === "acknowledged" &&
      adoption.generation !== null &&
      resource.lifecycle.kind === "acknowledged" &&
      resource.lifecycle.availabilityGeneration === adoption.generation &&
      previous.resource.identity.documentId === adoption.documentId &&
      previous.resource.identity.revision === adoption.identityRevision &&
      (previousContent.kind === "unacquired" ||
        (previousContent.initialization !== "reserved" &&
          previousContent.databaseName === adoption.exactDatabaseName));
    const createdLocalContent =
      previous?.resource.lifecycle.kind === "local" && source && adoption.generation === null;
    if (!createdLocalContent && !sameAcknowledgedCache && !acquiredServerCache)
      throw new Error("Session adoption requires created or acquired exact content");
  }
  if (resource.obligations.canonicalRefresh) {
    const operationId = resource.obligations.canonicalRefresh.operationId;
    const source = next.intents.some((intent) =>
      intent.attempts.some(
        (attempt) =>
          attempt.request.kind === "move" &&
          attempt.outcome?.kind === "operation" &&
          attempt.outcome.receipt.operationId === operationId &&
          attempt.outcome.receipt.result.ok,
      ),
    );
    if (!source) throw new Error("Canonical refresh requires a successful move receipt");
  }
  validateNamespaceJournal({
    previous: previous ? { handle: previous.resource.handle, intents: previous.intents } : null,
    next: { handle: resource.handle, intents: next.intents },
    identityRevision: resource.identity.revision,
    localDeletionAllowed:
      resource.lifecycle.kind === "local" &&
      resource.canonical === null &&
      !next.intents.some((item) => item.attempts.length > 0),
  });
  const oldRefresh = previous?.resource.obligations.canonicalRefresh;
  const nextRefresh = resource.obligations.canonicalRefresh;
  if (oldRefresh && nextRefresh && JSON.stringify(oldRefresh) !== JSON.stringify(nextRefresh))
    throw new Error("Canonical refresh obligation cannot be replaced");
  const oldAdoption = previous?.resource.obligations.sessionAdoption;
  if (oldAdoption && adoption) {
    const { generation: _oldGeneration, ...oldWitness } = oldAdoption;
    const { generation: _nextGeneration, ...nextWitness } = adoption;
    if (
      JSON.stringify(oldWitness) !== JSON.stringify(nextWitness) ||
      (oldAdoption.generation !== null && adoption.generation !== oldAdoption.generation)
    )
      throw new Error("Session adoption obligation cannot be replaced");
  }
  if (
    oldAdoption &&
    !adoption &&
    resource.lifecycle.kind !== "terminal" &&
    (oldAdoption.generation === null ||
      resource.lifecycle.kind !== "acknowledged" ||
      resource.lifecycle.availabilityGeneration !== oldAdoption.generation)
  )
    throw new Error("Session adoption can clear only after exact admission");
}
