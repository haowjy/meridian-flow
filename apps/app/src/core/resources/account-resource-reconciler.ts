/**
 * Account-scoped background reconciliation of resource metadata: one runner per handle (a
 * resource's, a folder's or an operation's) that dispatches namespace work, follows joins and
 * reminted creates, adopts sessions and cleans up deleted content. Retry triggers and projection
 * observations feed it; the replica composes it.
 * Runners are independent: a placement waits only for the predecessors its journal admission
 * names (`placementDispatchVerdict`), so unrelated work never queues behind a held request.
 */
import {
  acknowledgeLocalResourceCleanup,
  awaitsRemint,
  type FolderNamespaceRecord,
  folderNeedsBackgroundReconciliation,
  joinReservation,
  latestAdmittedPlacement,
  type NamespaceIntent,
  type OperationRecord,
  operationNeedsBackgroundReconciliation,
  type PlacementPredecessor,
  type PlacementVerdict,
  pendingJoinProject,
  pendingJoinTarget,
  placementDispatchVerdict,
  type ResourceKey,
  type ResourceNamespaceLock,
  type ResourceRecord,
  type ResourceWrite,
  reconcileFolderNamespace,
  reconcileOperationNamespace,
  reconcileResourceNamespace,
  remintFolder,
  remintResource,
  resourceIdentityIndex,
  resourceNeedsBackgroundReconciliation,
  settleNamespaceOutcome,
} from "@meridian/resource-replica";
import type { ConnectivityHintsPort } from "@/core/transport/connectivity-hints";
import type { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import type { ResourceContentAccess } from "./resource-content-access";
import type { ResourceSessionAdoptionCoordinator } from "./resource-session-adoption";

const RETRY_INTERVAL_MS = 30_000;

export type ResourcePlanCommit = (
  key: ResourceKey,
  plan: (record: ResourceRecord) => ResourceWrite | null,
) => Promise<"committed" | "unchanged">;

/** What the reconciler may touch; the replica supplies the concrete account adapters. */
export type ResourceReconcilerPorts = {
  metadata: IndexedDbResourceMetadata;
  content: Pick<
    ResourceContentAccess,
    "prepareReidentity" | "reconcileMetadata" | "clearExactContent"
  >;
  adoption: Pick<ResourceSessionAdoptionCoordinator, "reconcile">;
  namespace: Parameters<typeof reconcileResourceNamespace>[0]["transport"];
  lock: ResourceNamespaceLock;
  commitPlan: ResourcePlanCommit;
  /** Resolves once no server-session capture is in flight for the handle. */
  capturesSettled(handle: string): Promise<void>;
  isClosing(): boolean;
};

/** A metadata write, and the Y.Doc session's new id when the write changes it. */
type IdentityPlan = { write: ResourceWrite; nextDocumentId?: string };

/**
 * The one identity transition: prepare the Y.Doc session's re-identity, commit the metadata, and
 * adopt the winner when another context committed first. Whatever stops the commit (a stale
 * write or a rejected one) releases the preparation, so the next pass can plan again.
 */
export async function commitIdentityChange(
  {
    metadata,
    content,
  }: {
    metadata: Pick<ResourceReconcilerPorts["metadata"], "readResource" | "commitResource">;
    content: Pick<ResourceReconcilerPorts["content"], "prepareReidentity" | "reconcileMetadata">;
  },
  key: ResourceKey,
  currentDocumentId: string,
  { write, nextDocumentId }: IdentityPlan,
): Promise<void> {
  const prepared = nextDocumentId
    ? content.prepareReidentity(
        key,
        currentDocumentId,
        nextDocumentId,
        write.next.resource.identity.revision,
      )
    : null;
  try {
    if ((await metadata.commitResource(write)) === "stale") {
      prepared?.abort();
      const winner = await metadata.readResource(key);
      if (winner) content.reconcileMetadata(winner);
      return;
    }
  } catch (error) {
    prepared?.abort();
    throw error;
  }
  prepared?.commit();
}

function newAttemptIds() {
  return { attemptId: crypto.randomUUID(), operationId: crypto.randomUUID() };
}

export class AccountResourceReconciler {
  private readonly runners = new Map<string, Promise<void>>();
  private readonly reruns = new Map<string, () => void>();
  private readonly observedResourceRevisions = new Map<string, number>();
  private readonly observedFolderRevisions = new Map<string, number>();
  private readonly observedOperationRevisions = new Map<string, number>();
  /** Handles holding a placement behind predecessors, woken when a journal they wait on changes. */
  private readonly waiting = new Map<string, { rerun: () => void; on: ReadonlySet<string> }>();
  private stopHints: (() => void) | null = null;
  private retryTimer: number | null = null;

  constructor(private readonly ports: ResourceReconcilerPorts) {}

  /** Retry triggers belong to the account lifetime, not to mounted catalog consumers. */
  start(hints?: ConnectivityHintsPort): void {
    this.stopHints =
      hints?.subscribe(this, (hint) => {
        if (hint === "retry-now") this.retryAll();
      }) ?? null;
    this.retryTimer = window.setInterval(this.retryAll, RETRY_INTERVAL_MS);
  }

  beginClose(): void {
    this.stopHints?.();
    this.stopHints = null;
    if (this.retryTimer !== null) window.clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  /** Every runner still working, for the close fence. */
  pending(): Promise<void>[] {
    return [...this.runners.values()];
  }

  runnerFor(key: ResourceKey): Promise<void> | undefined {
    return this.runners.get(encodeURIComponent(key.handle));
  }

  reconcileProjection(
    records: readonly ResourceRecord[],
    folders: readonly FolderNamespaceRecord[],
    operations: readonly OperationRecord[],
  ): void {
    const changed = new Set<string>();
    for (const record of records) {
      const { handle, revision } = record.resource;
      if (this.observedResourceRevisions.get(handle) === revision) continue;
      this.observedResourceRevisions.set(handle, revision);
      changed.add(handle);
      this.ports.content.reconcileMetadata(record);
      this.schedule(record.resource);
    }
    for (const folder of folders) {
      if (this.observedFolderRevisions.get(folder.handle) === folder.revision) continue;
      this.observedFolderRevisions.set(folder.handle, folder.revision);
      changed.add(folder.handle);
      if (folderNeedsBackgroundReconciliation(folder)) this.scheduleFolder(folder);
    }
    for (const operation of operations) {
      const { operationId, revision } = operation;
      if (this.observedOperationRevisions.get(operationId) === revision) continue;
      this.observedOperationRevisions.set(operationId, revision);
      changed.add(operationId);
      if (operationNeedsBackgroundReconciliation(operation)) this.scheduleOperation(operation);
    }
    // A change from any tab may resolve a predecessor; only its waiters look again.
    for (const { rerun, on } of [...this.waiting.values()])
      if ([...on].some((handle) => changed.has(handle))) rerun();
  }

  schedule(key: ResourceKey): void {
    this.scheduleOnce(
      key,
      () => this.run(key),
      () => this.schedule(key),
    );
  }

  scheduleFolder(key: ResourceKey): void {
    this.scheduleOnce(
      key,
      () => this.runFolder(key),
      () => this.scheduleFolder(key),
    );
  }

  /** An operation's handle is its id: `key.handle` and `operationId` are the same string. */
  private scheduleOperation(operation: Pick<OperationRecord, "operationId">): void {
    const key = { handle: operation.operationId };
    this.scheduleOnce(
      key,
      () => this.runOperation(key),
      () => this.scheduleOperation(operation),
    );
  }

  private readonly retryAll = () => {
    void this.ports.metadata
      .readProjection("")
      .then(({ records, folders, operations }) => {
        for (const record of records)
          if (resourceNeedsBackgroundReconciliation(record)) this.schedule(record.resource);
        for (const folder of folders)
          if (folderNeedsBackgroundReconciliation(folder)) this.scheduleFolder(folder);
        for (const operation of operations)
          if (operationNeedsBackgroundReconciliation(operation)) this.scheduleOperation(operation);
      })
      .catch(() => undefined);
  };

  /** One runner per handle; a request that arrives mid-run reruns once when it finishes. */
  private scheduleOnce(key: ResourceKey, start: () => Promise<void>, rerun: () => void): void {
    if (this.ports.isClosing()) return;
    const id = encodeURIComponent(key.handle);
    if (this.runners.has(id)) {
      this.reruns.set(id, rerun);
      return;
    }
    this.waiting.delete(id);
    const runner = start()
      .catch(() => undefined)
      .finally(() => {
        if (this.runners.get(id) !== runner) return;
        this.runners.delete(id);
        const again = this.reruns.get(id);
        this.reruns.delete(id);
        again?.();
      });
    this.runners.set(id, runner);
  }

  private async runFolder(key: ResourceKey): Promise<void> {
    const { metadata, namespace: transport, lock } = this.ports;
    for (let step = 0; step < 100 && !this.ports.isClosing(); step += 1) {
      const result = await reconcileFolderNamespace({
        key,
        metadata,
        transport,
        lock,
        newAttemptIds,
        gate: this.gate(key, () => this.scheduleFolder(key)),
      });
      if ((result === "needs-repair" || result === "blocked") && (await this.remintFolder(key)))
        continue;
      if (result !== "progressed") return;
    }
  }

  private async runOperation(key: ResourceKey): Promise<void> {
    const { metadata, namespace: transport, lock } = this.ports;
    for (let step = 0; step < 100 && !this.ports.isClosing(); step += 1) {
      const result = await reconcileOperationNamespace({
        key,
        metadata,
        transport,
        lock,
        newAttemptIds,
        gate: this.gate(key, () => this.scheduleOperation({ operationId: key.handle })),
      });
      if (result !== "progressed") return;
    }
  }

  private async run(key: ResourceKey): Promise<void> {
    const { metadata, namespace: transport, lock, adoption } = this.ports;
    for (let step = 0; step < 100 && !this.ports.isClosing(); step += 1) {
      const namespace = await reconcileResourceNamespace({
        key,
        metadata,
        transport,
        lock,
        newAttemptIds,
        gate: this.gate(key, () => this.schedule(key)),
      });
      if (namespace === "needs-join" && (await this.commitIdentity(key, (c) => this.planJoin(c))))
        continue;
      if (
        (namespace === "needs-repair" || namespace === "blocked") &&
        (await this.commitIdentity(key, planRemint))
      )
        continue;
      await this.ports.capturesSettled(key.handle);
      const adopted = await adoption.reconcile(key);
      const cleanup = await this.reconcileLocalCleanup(key);
      if (namespace !== "progressed" && adopted !== "adopted" && !cleanup) return;
    }
  }

  /**
   * Replaces a spent folder id. The store commits the remint together with the unsent placements
   * that named the old id, so no child reaches the server naming a folder it cannot use.
   */
  private async remintFolder(key: ResourceKey): Promise<boolean> {
    const current = await this.ports.metadata.readFolder(key);
    if (!current) return false;
    const write = remintFolder({
      record: current,
      folderId: crypto.randomUUID(),
      retryIntentId: crypto.randomUUID(),
      rebasedIntentIds: Object.fromEntries(
        current.intents
          .filter((intent) => intent.state === "pending" && intent.attempts.length === 0)
          .map((intent) => [intent.intentId, crypto.randomUUID()]),
      ),
    });
    return write !== null && (await this.ports.metadata.commitFolder(write)) === "committed";
  }

  /**
   * Holds a placement behind its predecessors. The handle is registered as waiting before the
   * predecessors are read, so a change that lands while reading still wakes it. A predecessor on a
   * spent id waits too: it is being replaced, and its replacement carries the same placement.
   */
  private gate(key: ResourceKey, rerun: () => void) {
    const id = encodeURIComponent(key.handle);
    return async (intent: NamespaceIntent): Promise<PlacementVerdict> => {
      const predecessors = intent.admission?.predecessors ?? [];
      if (predecessors.length === 0) return "go";
      this.waiting.set(id, { rerun, on: new Set(predecessors.map((ref) => ref.handle)) });
      const found = new Map<number, NamespaceIntent | undefined>();
      let replacing = false;
      for (const ref of predecessors) {
        const journal = await this.predecessorJournal(ref);
        found.set(
          ref.order,
          journal ? latestAdmittedPlacement(journal.intents, ref.order) : undefined,
        );
        if (journal?.replacing) replacing = true;
      }
      const verdict = replacing
        ? "wait"
        : placementDispatchVerdict(intent, (ref) => found.get(ref.order));
      if (verdict !== "wait") this.waiting.delete(id);
      return verdict;
    };
  }

  /** The journal a predecessor names, and whether it is mid-replacement (a spent id: an operation never is). */
  private async predecessorJournal(
    ref: PlacementPredecessor,
  ): Promise<{ intents: readonly NamespaceIntent[]; replacing: boolean } | null> {
    const { metadata } = this.ports;
    if (ref.kind === "operation") {
      const operation = await metadata.readOperation(ref.handle);
      return operation && { intents: operation.intents, replacing: false };
    }
    if (ref.kind === "folder") {
      const folder = await metadata.readFolder({ handle: ref.handle });
      return folder && { intents: folder.intents, replacing: awaitsRemint(folder) };
    }
    const record = await metadata.readResource({ handle: ref.handle });
    return (
      record && {
        intents: record.intents,
        replacing: awaitsRemint({
          serverHold: record.resource.serverHold,
          intents: record.intents,
        }),
      }
    );
  }

  /** Returns whether a plan applied or a conflict was settled, so the runner takes another pass. */
  private async commitIdentity(
    key: ResourceKey,
    plan: (current: ResourceRecord) => IdentityPlan | null | Promise<IdentityPlan | null>,
  ): Promise<boolean> {
    const current = await this.ports.metadata.readResource(key);
    const planned = current && (await plan(current));
    if (!current || !planned) return false;
    await commitIdentityChange(this.ports, key, current.resource.identity.documentId, planned);
    return true;
  }

  /**
   * The create was answered `joined`: re-identify the reservation to the joined document around
   * its session. When another record already holds that id nothing folds; the create is settled
   * as refused and the next pass reminted it.
   */
  private async planJoin(current: ResourceRecord): Promise<IdentityPlan | null> {
    const target = pendingJoinTarget(current);
    const projectId = pendingJoinProject(current);
    if (!target || !projectId) return null;
    const { records } = await this.ports.metadata.readProjection(projectId);
    const owner = resourceIdentityIndex(records).byDocumentId(target.documentId);
    if (owner && owner.resource.handle !== current.resource.handle) {
      const write = settleNamespaceOutcome(current, Date.now(), true);
      return write && { write };
    }
    const write = joinReservation({ record: current, target, settledAt: Date.now() });
    return write && { write, nextDocumentId: target.documentId };
  }

  private async reconcileLocalCleanup(key: ResourceKey): Promise<boolean> {
    const { metadata, content } = this.ports;
    const result = await this.ports.lock.run(key, async () => {
      const record = await metadata.readResource(key);
      const cleanup = record?.resource.obligations.cleanup;
      const deletion = record?.intents.find(
        (intent) =>
          intent.desired.kind === "delete" &&
          intent.state === "settled-locally" &&
          intent.intentId === cleanup?.obligationId,
      );
      if (!record || !cleanup || !deletion) return false;
      // A local deletion's content waits out its Undo window; the 30 s retry finds it due.
      if (cleanup.notBefore !== undefined && Date.now() < cleanup.notBefore) return false;
      await content.clearExactContent({
        projectId: deletion.projectId,
        key,
        documentId: record.resource.identity.documentId,
        databaseName: cleanup.exactDatabaseName,
      });
      await this.ports.commitPlan(key, (current) =>
        acknowledgeLocalResourceCleanup({
          record: current,
          transitionId: deletion.intentId,
          exactDatabaseName: cleanup.exactDatabaseName,
        }),
      );
      return true;
    });
    return result.kind === "acquired" && result.value;
  }
}

function planRemint(current: ResourceRecord): IdentityPlan | null {
  const nextDocumentId = crypto.randomUUID();
  const rebasedIntentIds = Object.fromEntries(
    current.intents
      .filter(
        (intent) =>
          intent.state === "pending" &&
          intent.attempts.length === 0 &&
          intent.identityRevision === current.resource.identity.revision,
      )
      .map((intent) => [intent.intentId, crypto.randomUUID()]),
  );
  const write = remintResource({
    record: current,
    documentId: nextDocumentId,
    retryIntentId: crypto.randomUUID(),
    rebasedIntentIds,
  });
  return write && { write, nextDocumentId };
}
