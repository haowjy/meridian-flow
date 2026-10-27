/**
 * The journal of an operation that spans several records (a Copy): one record per operation id,
 * holding the operation's own intents and attempts. It is the third journal kind beside a
 * resource's and a folder's, and it rides the same generic replay (`reconcileNamespaceJournal`),
 * placement admission and predecessor gate.
 */
import { validateNamespaceJournal } from "./namespace-journal-policy";
import type { MetadataCommitResult, OperationRecord, OperationWrite } from "./resource-records";

/** Browser persistence implements this beside its file and folder journals, in the same account owner. */
export interface OperationStore {
  readonly accountId: string;
  readOperation(operationId: string): Promise<OperationRecord | null>;
  commitOperation(write: OperationWrite): Promise<MetadataCommitResult>;
}

export function validateOperationRecordUpdate(
  previous: OperationRecord | null,
  next: OperationRecord,
): void {
  if (next.revision !== (previous?.revision ?? 0) + 1)
    throw new Error("Invalid operation revision");
  if (
    previous &&
    (next.operationId !== previous.operationId || next.projectId !== previous.projectId)
  )
    throw new Error("Operation identity mismatch");
  if (
    next.intents.some(
      (intent) => intent.projectId !== next.projectId || intent.identityRevision !== 1,
    )
  )
    throw new Error("Operation journal intents belong to the operation's project");
  validateNamespaceJournal({
    previous: previous && { handle: previous.operationId, intents: previous.intents },
    next: { handle: next.operationId, intents: next.intents },
    identityRevision: 1,
  });
}
