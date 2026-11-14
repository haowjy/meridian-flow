/**
 * This browser's local copies of live documents: the IndexedDB database a session persists a
 * document into, named by the account and the document id alone. A copy is deleted only when it
 * cannot come back to the account (its node's purge, its project, Work or chat deleted for good,
 * the account removed from the project, sign-out), so nothing here is ordered or fenced.
 *
 * One Web Lock per copy keeps a tab from deleting a database another tab has open: a session
 * holds it shared while it lives, a deletion takes it exclusive and gives up when a hold exists.
 * A copy a crashed tab left behind is found by `list` and cleared against the list at next start.
 */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { type CrossContextLockManager, deferred, nativeLocks } from "../cross-context-locks";

const PREFIX = `meridian:document:${collabSchemaKeyTag()}:live/`;

export function documentSessionPersistenceKey(accountId: AccountId, documentId: DocumentId) {
  return `${PREFIX}${encodeURIComponent(accountId)}/${encodeURIComponent(documentId)}`;
}

export type CopyHold = { release(): void };

export class LocalDocumentCopies {
  constructor(
    private readonly accountId: AccountId,
    private readonly locks: CrossContextLockManager | null = nativeLocks(),
    private readonly idb: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB,
  ) {}

  private lockName(documentId: DocumentId) {
    return `meridian:local-copy:v1:${encodeURIComponent(this.accountId)}/${encodeURIComponent(documentId)}`;
  }

  /** Shared hold while a session has the copy open; release it once the session is destroyed. */
  async hold(documentId: DocumentId): Promise<CopyHold> {
    if (!this.locks) return { release: () => undefined };
    const acquired = deferred<void>();
    const released = deferred<void>();
    void this.locks
      .request(this.lockName(documentId), { mode: "shared" }, async () => {
        acquired.resolve();
        await released.promise;
      })
      .catch(acquired.reject);
    await acquired.promise;
    return { release: () => released.resolve() };
  }

  /**
   * Deletes the copy. False when another tab holds it open: that tab's own list reading clears
   * it, and a copy left behind is found by `list` on the next start.
   */
  async clear(documentId: DocumentId): Promise<boolean> {
    const deleteIt = () =>
      this.deleteDatabase(documentSessionPersistenceKey(this.accountId, documentId));
    if (!this.locks) {
      await deleteIt();
      return true;
    }
    return this.locks.request(
      this.lockName(documentId),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) return false;
        await deleteIt();
        return true;
      },
    );
  }

  /** The documents this browser holds a copy of for the account. */
  async list(): Promise<DocumentId[]> {
    if (!this.idb?.databases) return [];
    const prefix = `${PREFIX}${encodeURIComponent(this.accountId)}/`;
    return (await this.idb.databases()).flatMap(({ name }) =>
      name?.startsWith(prefix) ? [decodeURIComponent(name.slice(prefix.length)) as DocumentId] : [],
    );
  }

  private deleteDatabase(name: string): Promise<void> {
    const idb = this.idb;
    if (!idb) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const request = idb.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB delete failed"));
    });
  }
}
