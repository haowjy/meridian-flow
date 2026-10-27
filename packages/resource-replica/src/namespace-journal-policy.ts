/** Immutable ordered namespace journal contracts, shared by file and folder records. */
import {
  intentOwnsDeletion,
  type NamespaceIntentOutcome,
  namespaceIntentOutcome,
} from "./resource-intent-policy";
import {
  type NamespaceIntent,
  namespaceRequestId,
  type PlacementAdmission,
  type ResourceDestination,
} from "./resource-records";
import type { ServerHold } from "./server-hold";

type Journal = { handle: string; intents: readonly NamespaceIntent[] };

/**
 * Both journals use this transition; effects belong to the identity's own layer. A refusal retires
 * the placements queued behind it, except on a spent id: that work moves to a new one.
 */
export function settleNamespaceIntent(
  intents: readonly NamespaceIntent[],
  intent: NamespaceIntent,
  disposition: NamespaceIntentOutcome,
  settledAt: number,
  hold: ServerHold,
): NamespaceIntent[] {
  const state =
    disposition === "accepted"
      ? "settled"
      : disposition === "refused"
        ? "needs-repair"
        : disposition;
  const next = intents.map(
    (current): NamespaceIntent =>
      current.intentId === intent.intentId ? { ...current, state, settledAt } : current,
  );
  const evidence = intent.attempts.at(-1)?.outcome;
  return disposition === "refused" &&
    hold !== "spent" &&
    evidence &&
    namespaceIntentOutcome(evidence) === "refused"
    ? resolveRefusedLocationChain(next, intent)
    : next;
}

/** Missing availability releases queued work into a visible repair route, not silent blocking. */
export function resolveUnavailableNamespace(
  intents: readonly NamespaceIntent[],
  terminal: boolean,
): NamespaceIntent[] {
  return intents.map(
    (intent): NamespaceIntent =>
      intent.state === "pending" || intent.state === "needs-repair"
        ? { ...intent, state: terminal ? "unexecutable-after-terminal" : "needs-repair" }
        : intent,
  );
}

/**
 * `intent` is queued placement work that rides on `earlier`: a later move of the same identity, or
 * a move queued behind its first placement. Both end with what refused `earlier`.
 */
function followsLocationIntent(intent: NamespaceIntent, earlier: NamespaceIntent): boolean {
  return (
    (earlier.desired.kind === "set-location" || earlier.desired.kind === "set-folder-location") &&
    intent.desired.kind === earlier.desired.kind &&
    intent.identityRevision === earlier.identityRevision &&
    intent.sequence > earlier.sequence
  );
}

/** Refusal retires queued placement; an admitted later delete also retires its repair blocker. */
export function resolveRefusedLocationChain(
  intents: readonly NamespaceIntent[],
  failed: NamespaceIntent,
): NamespaceIntent[] {
  const deleted =
    failed.desired.kind !== "delete" &&
    intents.some(
      (intent) =>
        intent.sequence > failed.sequence &&
        intent.identityRevision === failed.identityRevision &&
        intentOwnsDeletion(intent),
    );
  return intents.map((intent) =>
    intent.intentId === failed.intentId && deleted
      ? { ...intent, state: "superseded" }
      : followsLocationIntent(intent, failed) &&
          intent.state === "pending" &&
          intent.attempts.length === 0
        ? { ...intent, state: "cancelled" }
        : intent,
  );
}

/**
 * An admission after the entry it names has a new id: its order and predecessors stay, and its
 * scope (the keys later placements overlap with) names the new id wherever it named the old.
 */
export function renamedAdmission(
  admission: PlacementAdmission,
  from: string,
  to: string,
): PlacementAdmission {
  const rename = (key: string) =>
    key === `entry:${from}`
      ? `entry:${to}`
      : key === `parent:folder:${from}`
        ? `parent:folder:${to}`
        : key;
  return { ...admission, scope: admission.scope.map(rename).sort() };
}

/**
 * The journal side of replacing a spent id, shared by documents and folders. The failed placement
 * is superseded and sent again as a new intent, and the unsent intents queued behind it are
 * cancelled and queued again after it. Each copy keeps its place in the order and its
 * predecessors, so a placement that waited on the original keeps waiting on its replacement, and
 * its scope names the new id (`renamedAdmission`), so a placement admitted into the replacement
 * waits on it too. `from` is the identity revision of the work being replaced and `to` the one its
 * copies carry; `fromId` and `toId` are the entry ids they replace. Null when nothing is left to
 * send.
 */
export function remintJournal(input: {
  intents: readonly NamespaceIntent[];
  from: number;
  to: number;
  fromId: string;
  toId: string;
  retryIntentId: string;
  rebasedIntentIds: Readonly<Record<string, string>>;
}): NamespaceIntent[] | null {
  const { intents } = input;
  const failed = [...intents]
    .filter(
      (intent) =>
        intent.state === "needs-repair" &&
        intent.identityRevision === input.from &&
        (intent.desired.kind === "set-location" || intent.desired.kind === "set-folder-location"),
    )
    .sort((left, right) => right.sequence - left.sequence)[0];
  const dependents = intents.filter(
    (intent) =>
      (!failed || intent.sequence > failed.sequence) &&
      intent.identityRevision === input.from &&
      intent.state === "pending" &&
      intent.attempts.length === 0,
  );
  for (const dependent of dependents) {
    if (!input.rebasedIntentIds[dependent.intentId])
      throw new Error("Remint requires an identity for every dependent intention");
  }
  if (!failed && dependents.length === 0) return null;
  let sequence = Math.max(0, ...intents.map((intent) => intent.sequence));
  const retry: NamespaceIntent[] = failed
    ? [
        {
          projectId: failed.projectId,
          handle: failed.handle,
          intentId: input.retryIntentId,
          sequence: ++sequence,
          identityRevision: input.to,
          desired: failed.desired,
          // The retry stands where the failed placement stood in the account's causal order.
          ...(failed.admission
            ? { admission: renamedAdmission(failed.admission, input.fromId, input.toId) }
            : {}),
          attempts: [],
          state: "pending",
        },
      ]
    : [];
  const rebased = dependents.map(
    (intent): NamespaceIntent => ({
      ...intent,
      intentId: input.rebasedIntentIds[intent.intentId] as string,
      sequence: ++sequence,
      identityRevision: input.to,
      ...(intent.admission
        ? { admission: renamedAdmission(intent.admission, input.fromId, input.toId) }
        : {}),
    }),
  );
  return [
    ...intents.map((intent) =>
      intent.intentId === failed?.intentId
        ? { ...intent, state: "superseded" as const }
        : dependents.includes(intent)
          ? { ...intent, state: "cancelled" as const }
          : intent,
    ),
    ...retry,
    ...rebased,
  ];
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
  if (latest.desired.kind === "set-location")
    return { ...latest.desired.destination, name: latest.desired.typedName };
  return latest.desired.kind === "set-folder-location" ? latest.desired.destination : null;
}

/**
 * The Undo window a deletion that settled on this device leaves open: its obligation id and the
 * time it closes.
 */
export type LocalDeletionWindow = { obligationId: string; notBefore?: number };

/**
 * Undo of a deletion that settled on this device, inside its window: the deletion is superseded
 * and the identity's latest placement is queued again, since what the deletion cancelled cannot
 * restart. Null once the window has closed (the content may already be cleaned up) or when no
 * such deletion is held. Each journal clears its own window field around this.
 */
export function undoLocalDeletion(input: {
  intents: readonly NamespaceIntent[];
  window: LocalDeletionWindow | null | undefined;
  operationId: string;
  createIntentId: string;
  identityRevision: number;
  now: number;
}): NamespaceIntent[] | null {
  const deletion = input.intents.find(
    (intent) =>
      intent.operationId === input.operationId &&
      intent.desired.kind === "delete" &&
      intent.state === "settled-locally",
  );
  const window = input.window;
  if (
    !deletion ||
    window?.obligationId !== deletion.intentId ||
    (window.notBefore !== undefined && input.now >= window.notBefore)
  )
    return null;
  const placement = input.intents
    .filter(
      (intent) =>
        intent.desired.kind === "set-location" || intent.desired.kind === "set-folder-location",
    )
    .sort((left, right) => right.sequence - left.sequence)[0];
  if (!placement) return null;
  return [
    ...input.intents.map((intent) =>
      intent === deletion ? { ...intent, state: "superseded" as const } : intent,
    ),
    {
      projectId: placement.projectId,
      handle: placement.handle,
      intentId: input.createIntentId,
      sequence: Math.max(...input.intents.map((intent) => intent.sequence)) + 1,
      identityRevision: input.identityRevision,
      desired: placement.desired,
      ...(placement.admission ? { admission: placement.admission } : {}),
      attempts: [],
      state: "pending",
    },
  ];
}

export function validateNamespaceJournal(input: {
  previous: Journal | null;
  next: Journal;
  identityRevision: number;
  localDeletionAllowed?: boolean;
  /** Local deletions whose Undo cleared their cleanup in this write: they may become superseded. */
  revokedLocalDeletions?: ReadonlySet<string>;
  terminal?: boolean;
}): void {
  const { previous, next, identityRevision, localDeletionAllowed = false } = input;
  const revoked = input.revokedLocalDeletions ?? new Set<string>();
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
          intent.state !== "superseded" &&
          intent.state !== "unexecutable-after-terminal"))
    )
      throw new Error("Invalid namespace settlement time");
    const attempts = new Set<string>();
    for (const attempt of intent.attempts) {
      if (attempts.has(attempt.attemptId)) throw new Error("Duplicate namespace attempt");
      attempts.add(attempt.attemptId);
      if (
        (attempt.request.kind === "move" &&
          ((attempt.request.body.sourceWorkId == null &&
            attempt.request.sourceWorkHandle != null) ||
            (attempt.request.body.destinationWorkId == null &&
              attempt.request.destinationWorkHandle != null) ||
            (attempt.request.body.sourceRootThreadId != null &&
              !attempt.request.sourceRootThreadRef) ||
            (attempt.request.body.destinationRootThreadId != null &&
              !attempt.request.destinationRootThreadRef))) ||
        (attempt.request.kind === "delete" &&
          ((attempt.request.workId == null && attempt.request.workHandle != null) ||
            (attempt.request.rootThreadId != null && !attempt.request.rootThreadRef)))
      )
        throw new Error("Namespace request Work authority is incomplete");
      if (
        attempt.outcome?.kind === "refusal" &&
        (attempt.outcome.operationId !== namespaceRequestId(attempt.request) ||
          attempt.outcome.error.retryable)
      )
        throw new Error("Namespace refusal does not match submitted request");
      if (attempt.outcome?.kind === "operation") {
        const receipt = attempt.outcome.receipt;
        if (
          attempt.request.kind === "create" ||
          attempt.request.kind === "create-folder" ||
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
            : request.kind === "copy" && command.kind === "copy"
              ? request.body.sources.length === command.sources.length &&
                request.body.sources.every(
                  (source, index) =>
                    source.copyId === command.sources[index]?.copyId &&
                    source.expected.kind === command.sources[index]?.expected.kind &&
                    source.expected.nodeId === command.sources[index]?.expected.nodeId,
                )
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
            attempt.outcome.result.status !== "joined" &&
            attempt.outcome.result.documentId !== attempt.request.body.documentId)
        )
          throw new Error("Create outcome does not match submitted identity");
      } else if (attempt.outcome?.kind === "create-folder") {
        if (
          attempt.request.kind !== "create-folder" ||
          (attempt.outcome.result.status !== "conflict" &&
            attempt.outcome.result.folderId !== attempt.request.body.folderId)
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
              (outcome?.kind === "refusal" ||
                (outcome?.kind === "operation" && !outcome.receipt.result.ok))
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
    // Recorded history survives a later restore of the identity; only entering it needs terminal.
    if (
      intent.state === "unexecutable-after-terminal" &&
      previousIntent?.state !== "unexecutable-after-terminal" &&
      !input.terminal
    )
      throw new Error("Non-executable namespace history requires terminal identity");
    const lastAttempt = intent.attempts.at(-1);
    if (intent.state === "submitted" && (!lastAttempt || lastAttempt.outcome))
      throw new Error("Submitted intention requires an unresolved attempt");
    if (intent.state === "received" && !lastAttempt?.outcome)
      throw new Error("Received intention requires a durable outcome");
    const outcome = lastAttempt?.outcome;
    const accepted = outcome && namespaceIntentOutcome(outcome) === "accepted";
    if (intent.state === "settled" && !accepted)
      throw new Error("Settled intention requires an accepted outcome");
    if (
      intent.state === "superseded" &&
      ((intent.attempts.length > 0 && !outcome) ||
        // An accepted answer the replica could not apply is `needs-repair` and ends superseded.
        (accepted && previousIntent?.state !== "needs-repair") ||
        (previousIntent &&
          previousIntent.state !== "needs-repair" &&
          previousIntent.state !== "received" &&
          previousIntent.state !== "superseded" &&
          !revoked.has(intent.intentId)))
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
      JSON.stringify(intent.desired) !== JSON.stringify(oldIntent.desired) ||
      JSON.stringify(intent.admission) !== JSON.stringify(oldIntent.admission)
    )
      throw new Error("Recorded namespace intention cannot be replaced");
    if (
      (oldIntent.state === "cancelled" || oldIntent.state === "settled-locally") &&
      ((intent.state !== oldIntent.state &&
        !(revoked.has(intent.intentId) && intent.state === "superseded")) ||
        intent.attempts.length > 0)
    )
      throw new Error("Locally completed namespace work cannot restart");
    if (
      (oldIntent.state === "settled" ||
        oldIntent.state === "superseded" ||
        oldIntent.state === "unexecutable-after-terminal") &&
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
