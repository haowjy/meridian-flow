/** Document lock namespace and native lease mechanics; admission owns lifecycle policy. */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId, ProjectId } from "@meridian/contracts/runtime";
import { type CrossContextLockManager, deferred } from "../cross-context-locks";

const LOCK_PREFIX = "meridian:f1d:v1:";
export type LifetimeHold = { release(): Promise<void> };
function encoded(value: string): string {
  return encodeURIComponent(value);
}

function operationLock(accountId: AccountId, documentId: DocumentId): string {
  return `${LOCK_PREFIX}operation/${encoded(accountId)}/${encoded(documentId)}`;
}

export function documentLifecycleLock(accountId: AccountId, documentId: DocumentId): string {
  return `${LOCK_PREFIX}document-lifecycle/${encoded(accountId)}/${encoded(documentId)}`;
}

export function accessLifecycleLock(
  accountId: AccountId,
  projectId: ProjectId,
  documentId: DocumentId,
): string {
  return `${LOCK_PREFIX}access-lifecycle/${encoded(accountId)}/${encoded(projectId)}/${encoded(documentId)}`;
}

export class DocumentSessionLocks {
  constructor(
    private readonly accountId: AccountId,
    private readonly locks: CrossContextLockManager,
    private readonly signal: AbortSignal,
    private readonly assertLifecycle: (state: "open" | "closing") => void,
    private readonly lifetimeHoldFactory: ((name: string) => Promise<LifetimeHold>) | null,
  ) {}
  async acquireLifetime(name: string): Promise<LifetimeHold> {
    if (this.lifetimeHoldFactory) return this.lifetimeHoldFactory(name);
    const acquired = deferred<void>();
    const released = deferred<void>();
    let callbackEntered = false;
    const lifetime = this.locks.request(
      name,
      { mode: "shared", signal: this.signal },
      async (lock) => {
        if (!lock) throw new Error(`Shared lifecycle lock unavailable: ${name}`);
        callbackEntered = true;
        acquired.resolve();
        await released.promise;
      },
    );
    void lifetime.catch((error) => {
      if (!callbackEntered) acquired.reject(error);
    });
    await acquired.promise;
    let releasePromise: Promise<void> | null = null;
    return {
      release: () => {
        if (!releasePromise) {
          released.resolve();
          releasePromise = lifetime;
        }
        return releasePromise;
      },
    };
  }

  withOperation<T>(documentId: DocumentId, callback: () => Promise<T>): Promise<T> {
    return this.locks.request(
      operationLock(this.accountId, documentId),
      { mode: "exclusive", signal: this.signal },
      async (lock) => {
        if (!lock) throw new Error("Operation lock unexpectedly unavailable");
        this.assertLifecycle("open");
        return callback();
      },
    );
  }

  operationFor<T>(
    closing: boolean,
    documentId: DocumentId,
    callback: () => Promise<T>,
  ): Promise<T> {
    if (!closing) return this.withOperation(documentId, callback);
    return this.locks.request(
      operationLock(this.accountId, documentId),
      { mode: "exclusive" },
      async (lock) => {
        if (!lock) throw new Error("Close operation lock unexpectedly unavailable");
        this.assertLifecycle("closing");
        return callback();
      },
    );
  }

  withExclusiveLifecycle<T>(name: string, callback: () => Promise<T>): Promise<T> {
    return this.locks.request(name, { mode: "exclusive", signal: this.signal }, async (lock) => {
      if (!lock) throw new Error("Lifecycle lock unexpectedly unavailable");
      return callback();
    });
  }

  exclusiveLifecycleFor<T>(closing: boolean, name: string, callback: () => Promise<T>): Promise<T> {
    if (!closing) return this.withExclusiveLifecycle(name, callback);
    return this.locks.request(name, { mode: "exclusive" }, async (lock) => {
      if (!lock) throw new Error("Close lifecycle lock unexpectedly unavailable");
      this.assertLifecycle("closing");
      return callback();
    });
  }

  async tryExclusiveLifecycle(name: string, callback: () => Promise<void>): Promise<boolean> {
    return this.locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
      if (!lock) return false;
      await callback();
      return true;
    });
  }
}
