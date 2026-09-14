/** Journal invariants shared by storage adapters; attempts are immutable once submitted. */
import type { ResourceRecord } from "./resource-records";

export function validateResourceRecordUpdate(
  previous: ResourceRecord | null,
  next: ResourceRecord,
): void {
  const resource = next.resource;
  if (resource.revision !== (previous?.resource.revision ?? 0) + 1)
    throw new Error("Invalid resource revision");
  if (
    previous &&
    (previous.resource.projectId !== resource.projectId ||
      previous.resource.handle !== resource.handle)
  )
    throw new Error("Resource identity mismatch");
  if (previous?.resource.lifecycle.kind === "terminal" && resource.lifecycle.kind !== "terminal")
    throw new Error("Terminal resources cannot be revived");
  if (resource.lifecycle.kind === "recovering" && resource.content.kind !== "recovery")
    throw new Error("Recovering resources require recovery evidence");
  if (
    resource.content.kind === "recovery" &&
    (resource.canonical !== null ||
      next.intents.length > 0 ||
      Object.keys(resource.obligations).length > 0)
  )
    throw new Error("Recovery resources cannot carry actionable namespace or cleanup work");
  const previousMax = Math.max(0, ...(previous?.intents.map((intent) => intent.sequence) ?? []));
  const previousIds = new Set(previous?.intents.map((intent) => intent.intentId));
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const intent of next.intents) {
    if (intent.projectId !== resource.projectId || intent.handle !== resource.handle)
      throw new Error("Resource intent identity mismatch");
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
    const lastAttempt = intent.attempts.at(-1);
    if (intent.state === "submitted" && (!lastAttempt || lastAttempt.outcome))
      throw new Error("Submitted intention requires an unresolved attempt");
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
      intent.sequence !== oldIntent.sequence ||
      intent.identityRevision !== oldIntent.identityRevision ||
      JSON.stringify(intent.desired) !== JSON.stringify(oldIntent.desired)
    )
      throw new Error("Recorded namespace intention cannot be replaced");
    if (
      oldIntent.state === "settled" &&
      (intent.state !== "settled" || intent.attempts.length !== oldIntent.attempts.length)
    )
      throw new Error("Settled intentions cannot restart");
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
}
