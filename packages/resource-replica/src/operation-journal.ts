/**
 * The journal of an operation that spans several records (a Copy): one record per operation id,
 * holding the operation's own intents and attempts. It is the third journal kind beside a
 * resource's and a folder's, and it rides the same generic replay (`reconcileNamespaceJournal`),
 * placement admission and predecessor gate.
 */
import { validateNamespaceJournal } from "./namespace-journal-policy";
import { NAMESPACE_RECEIPT_NOTE_TTL_MS } from "./namespace-receipts";
import { placementUnresolved, refreshBarrierOperationIds } from "./placement-journal";
import {
  type NamespaceGate,
  type NamespaceReconcileResult,
  reconcileNamespaceJournal,
} from "./resource-namespace";
import type {
  FolderNamespaceRecord,
  MetadataCommitResult,
  OperationReader,
  OperationRecord,
  OperationWrite,
  ResourceNamespaceLock,
  ResourceNamespaceTransport,
  ResourceRecord,
} from "./resource-records";

/** Browser persistence implements this beside its file and folder journals, in the same account owner. */
export interface OperationStore extends OperationReader {
  readonly accountId: string;
  commitOperation(write: OperationWrite): Promise<MetadataCommitResult>;
  /** Drops a retired operation; stale when it changed since `revision` was read. */
  retireOperation(operationId: string, revision: number): Promise<MetadataCommitResult>;
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

/**
 * The operations whose records have nothing left to say, for the caller to drop. Every projection
 * emit reads the whole store, so a record that is never dropped makes each emit slower as history
 * grows. An operation stays while it has unresolved work, while it `needs-repair` (a refusal
 * outlives a reload until the writer dismisses it), through the notice window of a settled
 * answer, and while a root's refresh barrier names it. A cancelled or superseded one has no
 * window: nothing shows it.
 */
export function retiredOperations(
  snapshot: {
    records: readonly ResourceRecord[];
    folders: readonly FolderNamespaceRecord[];
    operations: readonly OperationRecord[];
  },
  now: number,
): OperationRecord[] {
  if (snapshot.operations.length === 0) return [];
  const refreshing = refreshBarrierOperationIds(snapshot);
  return snapshot.operations.filter(
    (operation) =>
      !refreshing.has(operation.operationId) &&
      operation.intents.every((intent) => {
        switch (intent.state) {
          case "settled":
            return now >= (intent.settledAt ?? 0) + NAMESPACE_RECEIPT_NOTE_TTL_MS;
          case "cancelled":
          case "superseded":
            return true;
          default:
            return false;
        }
      }),
  );
}
