/** Immutable ordered namespace journal contracts, shared by file and folder records. */
import type { NamespaceIntent, ResourceDestination } from "./resource-records";

type Journal = { handle: string; intents: readonly NamespaceIntent[] };

function followsLocationIntent(intent: NamespaceIntent, earlier: NamespaceIntent): boolean {
  return (
    (earlier.desired.kind === "set-location" || earlier.desired.kind === "set-folder-location") &&
    intent.desired.kind === earlier.desired.kind &&
    intent.identityRevision === earlier.identityRevision &&
    intent.sequence > earlier.sequence
  );
}

/** Refusal retires the queued placement chain without rewriting its immutable destinations. */
export function cancelRefusedLocationChain(
  intents: readonly NamespaceIntent[],
  failed: NamespaceIntent,
): NamespaceIntent[] {
  return intents.map((intent) =>
    followsLocationIntent(intent, failed) &&
    intent.state === "pending" &&
    intent.attempts.length === 0
      ? { ...intent, state: "cancelled" }
      : intent,
  );
}

/** The failed receipt stays the repair anchor; its cancelled chain supplies the newest destination. */
export function namespaceRepairDestination(
  intents: readonly NamespaceIntent[],
  failed: NamespaceIntent,
): ResourceDestination | null {
  const latest = intents.reduce(
    (candidate, intent) =>
      intent.state === "cancelled" &&
      followsLocationIntent(intent, failed) &&
      intent.sequence > candidate.sequence
        ? intent
        : candidate,
    failed,
  );
  return latest.desired.kind === "set-location" || latest.desired.kind === "set-folder-location"
    ? latest.desired.destination
    : null;
}

export function validateNamespaceJournal(input: {
  previous: Journal | null;
  next: Journal;
  identityRevision: number;
  localDeletionAllowed?: boolean;
}): void {
  const { previous, next, identityRevision, localDeletionAllowed = false } = input;
  const previousMax = Math.max(0, ...(previous?.intents.map((intent) => intent.sequence) ?? []));
  const previousIds = new Set(previous?.intents.map((intent) => intent.intentId));
  const ids = new Set<string>();
  const sequences = new Set<number>();
  for (const intent of next.intents) {
    if (intent.handle !== next.handle) throw new Error("Resource intent identity mismatch");
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
    if (
      intent.settledAt !== undefined &&
      (!Number.isFinite(intent.settledAt) ||
        intent.settledAt < 0 ||
        (intent.state !== "settled" &&
          intent.state !== "needs-repair" &&
          intent.state !== "superseded"))
    )
      throw new Error("Invalid namespace settlement time");
    const attempts = new Set<string>();
    for (const attempt of intent.attempts) {
      if (attempts.has(attempt.attemptId)) throw new Error("Duplicate namespace attempt");
      attempts.add(attempt.attemptId);
      if (
        (attempt.request.kind === "move" &&
          ((attempt.request.body.sourceWorkId == null && attempt.request.sourceWorkSlug != null) ||
            (attempt.request.body.destinationWorkId == null &&
              attempt.request.destinationWorkSlug != null))) ||
        (attempt.request.kind === "delete" &&
          attempt.request.workId == null &&
          attempt.request.workSlug != null)
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
        (!next.intents.some(
          (later) => later.desired.kind === "delete" && later.sequence > intent.sequence,
        ) &&
          !next.intents.some((earlier) => {
            const outcome = earlier.attempts.at(-1)?.outcome;
            return (
              followsLocationIntent(intent, earlier) &&
              outcome?.kind === "operation" &&
              !outcome.receipt.result.ok
            );
          }) &&
          !next.intents.some(
            (later) =>
              later.sequence > intent.sequence &&
              later.identityRevision === identityRevision &&
              (JSON.stringify(later.desired) === JSON.stringify(intent.desired) ||
                ((intent.desired.kind === "set-location" ||
                  intent.desired.kind === "set-folder-location") &&
                  later.desired.kind === intent.desired.kind)),
          )))
    )
      throw new Error("Only superseded unsubmitted work can be cancelled");
    if (intent.state === "settled-locally") {
      if (
        next.intents.some(
          (other) =>
            other.intentId !== intent.intentId &&
            other.state !== "cancelled" &&
            other.state !== "superseded",
        )
      )
        throw new Error("Locally deleted resources cannot retain executable namespace work");
      if (intent.desired.kind !== "delete" || intent.attempts.length > 0)
        throw new Error("Local settlement requires retained deletion without an HTTP attempt");
      if (previousIntent?.state !== "settled-locally" && !localDeletionAllowed)
        throw new Error("Local deletion requires proven never-submitted identity");
    }
    const lastAttempt = intent.attempts.at(-1);
    if (intent.state === "submitted" && (!lastAttempt || lastAttempt.outcome))
      throw new Error("Submitted intention requires an unresolved attempt");
    if (intent.state === "received" && !lastAttempt?.outcome)
      throw new Error("Received intention requires a durable outcome");
    const outcome = lastAttempt?.outcome;
    const accepted =
      outcome?.kind === "operation"
        ? outcome.receipt.result.ok
        : outcome?.kind === "create" && outcome.result.status !== "conflict";
    if (intent.state === "settled" && !accepted)
      throw new Error("Settled intention requires an accepted outcome");
    if (
      intent.state === "superseded" &&
      ((intent.attempts.length > 0 && !outcome) ||
        accepted ||
        (previousIntent &&
          previousIntent.state !== "needs-repair" &&
          previousIntent.state !== "received" &&
          previousIntent.state !== "superseded"))
    )
      throw new Error("Only failed namespace work can be superseded");
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
      intent.operationId !== oldIntent.operationId ||
      (oldIntent.settledAt !== undefined && intent.settledAt !== oldIntent.settledAt) ||
      JSON.stringify(intent.desired) !== JSON.stringify(oldIntent.desired)
    )
      throw new Error("Recorded namespace intention cannot be replaced");
    if (
      (oldIntent.state === "cancelled" || oldIntent.state === "settled-locally") &&
      (intent.state !== oldIntent.state || intent.attempts.length > 0)
    )
      throw new Error("Locally completed namespace work cannot restart");
    if (
      (oldIntent.state === "settled" || oldIntent.state === "superseded") &&
      (intent.state !== oldIntent.state || intent.attempts.length !== oldIntent.attempts.length)
    )
      throw new Error("Terminal intentions cannot restart");
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
}
