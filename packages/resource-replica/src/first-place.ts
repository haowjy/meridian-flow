/**
 * Which accepted answer stands behind a record's place. A record is its own first-placement
 * authority (its create's answer, its move's receipt) unless an operation made it (`copiedBy`):
 * then the operation's receipt places it. The record validators and the canonical-refresh hooks
 * ask here, so a record made by an operation adds no exception to any of their rules.
 */
import { namespaceReceiptIs } from "./namespace-receipts";
import { namespaceIntentOutcome } from "./resource-intent-policy";
import type {
  CopiedBy,
  NamespaceIntent,
  NamespaceOutcome,
  OperationReader,
  OperationRecord,
} from "./resource-records";

/** A record's own journal, and the operation that made it, if one did. */
export type PlaceOrigin = { intents: readonly NamespaceIntent[]; copiedBy?: CopiedBy };

/** The operation's journal when the record names one; the validators read it inside their transaction. */
export function originOperation(
  origin: PlaceOrigin,
  operations: OperationReader,
): Promise<OperationRecord | null> {
  return origin.copiedBy
    ? operations.readOperation(origin.copiedBy.operationId)
    : Promise.resolve(null);
}

/** The accepted outcomes of the record's own attempts, and of the operation's when it made the record. */
function acceptedAnswers(
  origin: PlaceOrigin,
  operation: OperationRecord | null,
): { projectId: string; outcome: NamespaceOutcome }[] {
  const answers: { projectId: string; outcome: NamespaceOutcome }[] = [];
  const collect = (intents: readonly NamespaceIntent[], projectId?: string) => {
    for (const intent of intents)
      for (const { outcome } of intent.attempts)
        if (outcome && namespaceIntentOutcome(outcome) === "accepted")
          answers.push({ projectId: projectId ?? intent.projectId, outcome });
  };
  collect(origin.intents);
  if (operation && operation.operationId === origin.copiedBy?.operationId)
    collect(operation.intents, operation.projectId);
  return answers;
}

/** Whether an accepted answer put `id` where the record stands: its own create's, or its operation's receipt naming it as a `kind`. */
export function firstPlaceWitnessed(
  origin: PlaceOrigin,
  operation: OperationRecord | null,
  id: string,
  kind: "file" | "folder",
): boolean {
  return acceptedAnswers(origin, operation).some(
    ({ outcome }) =>
      outcome.kind === "create-folder" ||
      (outcome.kind === "operation" &&
        namespaceReceiptIs(outcome.receipt, "copy") &&
        outcome.receipt.result.ok &&
        outcome.receipt.result.value.entries.some(
          (entry) => entry.id === id && entry.kind === kind,
        )),
  );
}

/**
 * The accepted receipt a canonical-refresh barrier named `operationId` rests on, with the project
 * it ran in: a move the record's own journal recorded, or the Copy that made it. Null when
 * none stands behind the barrier.
 */
export function refreshWitness(
  origin: PlaceOrigin,
  operation: OperationRecord | null,
  operationId: string,
): { projectId: string } | null {
  return (
    acceptedAnswers(origin, operation).find(
      ({ outcome }) =>
        outcome.kind === "operation" &&
        outcome.receipt.operationId === operationId &&
        (namespaceReceiptIs(outcome.receipt, "move") ||
          namespaceReceiptIs(outcome.receipt, "copy")),
    ) ?? null
  );
}
