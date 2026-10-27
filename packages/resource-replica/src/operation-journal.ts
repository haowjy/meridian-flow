/**
 * The journal of an operation that spans several records (a Copy): one record per operation id,
 * holding the operation's own intents and attempts. It is the third journal kind beside a
 * resource's and a folder's, and it rides the same generic replay (`reconcileNamespaceJournal`),
 * placement admission and predecessor gate.
 */
import { validateNamespaceJournal } from "./namespace-journal-policy";
import { placementUnresolved } from "./placement-journal";
import {
  type NamespaceGate,
  type NamespaceReconcileResult,
  reconcileNamespaceJournal,
} from "./resource-namespace";
import type {
  MetadataCommitResult,
  OperationRecord,
  OperationWrite,
  ResourceNamespaceLock,
  ResourceNamespaceTransport,
} from "./resource-records";

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

/** Work that can progress without a new writer command, as `folderNeedsBackgroundReconciliation` for folders. */
export function operationNeedsBackgroundReconciliation(record: OperationRecord): boolean {
  return record.intents.some((intent) => placementUnresolved(intent.state));
}

/**
 * Reconciles one operation through the generic journal replay. An operation waits behind its
 * predecessors and can be sent to repair when their failure changed its premise; what an
 * operation kind sends, and how its answer lands, arrives with that kind (Copy's request,
 * its receipt and its roots). Until then nothing here sends, records or settles an answer.
 */
export function reconcileOperationNamespace(input: {
  /** The operation's handle: its operation id. */
  key: { handle: string };
  metadata: OperationStore;
  transport: ResourceNamespaceTransport;
  lock: ResourceNamespaceLock;
  newAttemptIds: () => { attemptId: string; operationId: string };
  gate?: NamespaceGate;
}): Promise<NamespaceReconcileResult> {
  return reconcileNamespaceJournal({
    ...input,
    read: () => input.metadata.readOperation(input.key.handle),
    commit: (write: OperationWrite) => input.metadata.commitOperation(write),
    prepare: async () => null,
    repair: (record, intentId) => ({
      expectedRevision: record.revision,
      next: {
        ...record,
        revision: record.revision + 1,
        intents: record.intents.map((intent) =>
          intent.intentId === intentId ? { ...intent, state: "needs-repair" } : intent,
        ),
      },
    }),
    recordOutcome: () => {
      throw new Error("No operation kind records an answer yet");
    },
    settle: () => null,
    refresh: async () => null,
    replayEligible: () => false,
  });
}
