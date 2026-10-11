/** Durable server deletion evidence, replayed under the owning account's namespace locks. */
import { committedResourceDeletion, type ResourceNamespaceLock } from "@meridian/resource-replica";
import type { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";

export type CommittedDeleteBatch = {
  projectId: string;
  deletedDocumentIds: readonly string[];
  generation: string;
};

type Store = Pick<
  IndexedDbResourceMetadata,
  | "readProjection"
  | "readResource"
  | "commitResource"
  | "retainCommittedDeletions"
  | "readCommittedDeletions"
  | "settleCommittedDeletion"
>;

export class CommittedDeletionIntake {
  private tail: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closing = false;

  constructor(
    private readonly metadata: Store,
    private readonly lock: ResourceNamespaceLock,
    private readonly epoch: AbortSignal,
  ) {
    epoch.addEventListener("abort", this.beginClose, { once: true });
    if (epoch.aborted) this.beginClose();
  }

  async accept(inputs: readonly CommittedDeleteBatch[]): Promise<void> {
    if (!inputs.length) return;
    // Descriptors are account-global. Index once for the entire settlement, not per descendant.
    const { records } = await this.metadata.readProjection("");
    if (this.closing) return;
    const byId = new Map(records.map(({ resource }) => [resource.identity.documentId, resource]));
    await this.metadata.retainCommittedDeletions(
      inputs.flatMap((input) =>
        [...new Set(input.deletedDocumentIds)].flatMap((documentId) => {
          const resource = byId.get(documentId);
          return resource
            ? [{ handle: resource.handle, documentId, generation: input.generation }]
            : [];
        }),
      ),
    );
    await this.retry();
  }

  retry(): Promise<void> {
    if (this.closing) return Promise.resolve();
    const attempt = this.tail.then(() => this.drain());
    // Evidence is already persisted. Local contention/failure must not turn a committed
    // server command into a failed confirmation; retry without the original caller.
    this.tail = attempt.catch(() => {
      this.scheduleRetry();
    });
    return this.tail;
  }

  private async drain(): Promise<void> {
    if (this.closing) return;
    for (const evidence of await this.metadata.readCommittedDeletions()) {
      if (this.closing) return;
      const key = { handle: evidence.handle };
      const result = await this.lock.run(key, async () => {
        while (!this.closing) {
          const record = await this.metadata.readResource(key);
          if (this.closing) return;
          if (
            !record ||
            record.resource.identity.documentId !== evidence.documentId ||
            record.resource.lifecycle.kind === "terminal" ||
            (record.resource.lifecycle.kind === "acknowledged" &&
              record.resource.lifecycle.availabilityGeneration !== null &&
              BigInt(record.resource.lifecycle.availabilityGeneration) >
                BigInt(evidence.generation))
          )
            break;
          const write = {
            expectedRevision: record.resource.revision,
            next: {
              ...record,
              resource: {
                ...committedResourceDeletion(
                  record.resource,
                  evidence.generation,
                  `delete:${evidence.documentId}:${evidence.generation}`,
                ),
                revision: record.resource.revision + 1,
              },
            },
          };
          if ((await this.metadata.commitResource(write)) === "committed") break;
        }
        if (!this.closing) await this.metadata.settleCommittedDeletion(evidence);
      });
      if (result.kind === "busy") this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.closing || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.retry();
    }, 250);
  }

  readonly beginClose = (): void => {
    this.closing = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  };

  async finishClose(): Promise<void> {
    this.beginClose();
    await this.tail;
    this.epoch.removeEventListener("abort", this.beginClose);
  }
}
