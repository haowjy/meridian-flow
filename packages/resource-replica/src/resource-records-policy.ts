/** Journal invariants shared by storage adapters; attempts are immutable once submitted. */
import type { ResourceRecord } from "./resource-records";

export function validateResourceRecordUpdate(
  previous: ResourceRecord | null,
  next: ResourceRecord,
): void {
  const resource = next.resource;
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
  if (adoption && !previous?.resource.obligations.sessionAdoption) {
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
    if (!source) throw new Error("Session adoption requires a successful create outcome");
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
  const previousMax = Math.max(0, ...(previous?.intents.map((intent) => intent.sequence) ?? []));
  const previousIds = new Set(previous?.intents.map((intent) => intent.intentId));
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const intent of next.intents) {
    if (intent.handle !== resource.handle) throw new Error("Resource intent identity mismatch");
    if (
      ids.has(intent.intentId) ||
      sequences.has(intent.sequence) ||
      !Number.isSafeInteger(intent.sequence) ||
      intent.sequence < 1
    )
      throw new Error("Duplicate or invalid intent order");
    if (!previousIds.has(intent.intentId) && intent.sequence <= previousMax)
      throw new Error("New intention must follow recorded history");
    ids.add(intent.intentId);
    sequences.add(intent.sequence);
    const attempts = new Set<string>();
    for (const attempt of intent.attempts) {
      if (attempts.has(attempt.attemptId)) throw new Error("Duplicate namespace attempt");
      attempts.add(attempt.attemptId);
      if (
        (attempt.request.kind === "move" &&
          ((attempt.request.body.sourceWorkId != null) !==
            (attempt.request.sourceWorkSlug != null) ||
            (attempt.request.body.destinationWorkId != null) !==
              (attempt.request.destinationWorkSlug != null))) ||
        (attempt.request.kind === "delete" &&
          (attempt.request.workId != null) !== (attempt.request.workSlug != null))
      )
        throw new Error("Namespace request Work authority is incomplete");
      if (attempt.outcome?.kind === "operation") {
        const receipt = attempt.outcome.receipt;
        if (
          attempt.request.kind === "create" ||
          receipt.command.kind !== attempt.request.kind ||
          receipt.operationId !== attempt.request.body.operationId
        )
          throw new Error("Namespace outcome does not match submitted request");
        const request = attempt.request;
        const command = receipt.command;
        const matchesIdentity =
          request.kind === "move" && command.kind === "move"
            ? request.body.expected.kind === command.expected.kind &&
              request.body.expected.nodeId === command.expected.nodeId
            : request.kind === "delete" &&
              command.kind === "delete" &&
              request.body.expected.kind === command.expected.kind &&
              (request.body.expected.kind !== "file" ||
                (command.expected.kind === "file" &&
                  request.body.expected.documentId === command.expected.documentId));
        if (!matchesIdentity)
          throw new Error("Namespace outcome does not match submitted identity");
      } else if (attempt.outcome?.kind === "create") {
        if (
          attempt.request.kind !== "create" ||
          (attempt.outcome.result.status !== "conflict" &&
            attempt.outcome.result.documentId !== attempt.request.body.documentId)
        )
          throw new Error("Create outcome does not match submitted identity");
      }
    }
    const previousIntent = previous?.intents.find((item) => item.intentId === intent.intentId);
    if (
      intent.state === "cancelled" &&
      (intent.attempts.length > 0 ||
        intent.desired.kind === "delete" ||
        !next.intents.some(
          (later) => later.desired.kind === "delete" && later.sequence > intent.sequence,
        ))
    )
      throw new Error("Only unsubmitted work superseded by deletion can be cancelled");
    if (intent.state === "settled-locally") {
      if (
        next.intents.some(
          (other) => other.intentId !== intent.intentId && other.state !== "cancelled",
        )
      )
        throw new Error("Locally deleted resources cannot retain executable namespace work");
      if (intent.desired.kind !== "delete" || intent.attempts.length > 0)
        throw new Error("Local settlement requires retained deletion without an HTTP attempt");
      if (
        previousIntent?.state !== "settled-locally" &&
        (resource.lifecycle.kind !== "local" ||
          resource.canonical !== null ||
          next.intents.some((item) => item.attempts.length > 0))
      )
        throw new Error("Local deletion requires proven never-submitted identity");
    }
    const lastAttempt = intent.attempts.at(-1);
    if (intent.state === "submitted" && (!lastAttempt || lastAttempt.outcome))
      throw new Error("Submitted intention requires an unresolved attempt");
    if (intent.state === "received" && !lastAttempt?.outcome)
      throw new Error("Received intention requires a durable outcome");
    if (intent.state === "settled" && !lastAttempt?.outcome)
      throw new Error("Settled intention requires an outcome");
    if (intent.state === "pending" && intent.attempts.length > 0)
      throw new Error("Recorded attempts cannot return to pending");
    if (intent.attempts.slice(0, -1).some((attempt) => !attempt.outcome))
      throw new Error("Uncertain attempt must settle before another submission");
  }
  for (const oldIntent of previous?.intents ?? []) {
    const intent = next.intents.find((item) => item.intentId === oldIntent.intentId);
    if (
      !intent ||
      intent.projectId !== oldIntent.projectId ||
      intent.sequence !== oldIntent.sequence ||
      intent.identityRevision !== oldIntent.identityRevision ||
      JSON.stringify(intent.desired) !== JSON.stringify(oldIntent.desired)
    )
      throw new Error("Recorded namespace intention cannot be replaced");
    if (
      (oldIntent.state === "cancelled" || oldIntent.state === "settled-locally") &&
      (intent.state !== oldIntent.state || intent.attempts.length > 0)
    )
      throw new Error("Locally completed namespace work cannot restart");
    if (
      oldIntent.state === "settled" &&
      (intent.state !== "settled" || intent.attempts.length !== oldIntent.attempts.length)
    )
      throw new Error("Settled intentions cannot restart");
    if (
      oldIntent.state === "received" &&
      (intent.state === "pending" ||
        intent.state === "submitted" ||
        intent.attempts.length !== oldIntent.attempts.length ||
        !intent.attempts.at(-1)?.outcome)
    )
      throw new Error("Received outcomes cannot return to submission");
    for (const [index, oldAttempt] of oldIntent.attempts.entries()) {
      const attempt = intent.attempts[index];
      if (
        !attempt ||
        attempt.attemptId !== oldAttempt.attemptId ||
        JSON.stringify(attempt.request) !== JSON.stringify(oldAttempt.request)
      )
        throw new Error("Submitted namespace request cannot be replaced");
      if (
        oldAttempt.outcome &&
        JSON.stringify(oldAttempt.outcome) !== JSON.stringify(attempt.outcome)
      )
        throw new Error("Recorded namespace outcome cannot be replaced");
    }
  }
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
