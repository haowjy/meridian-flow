/**
 * This browser's local copies of one account's documents, live and draft: the IndexedDB databases
 * a session persists a document into, named by the account and the document id. The registry
 * holds one inventory per account, whoever has a view of the document: a copy is found and
 * deleted by its document id.
 *
 * A copy is deleted only on a fact that is final (`list-removal-observer`: the node's purge, its
 * Work or chat purged, the account removed from the project) or when the account signs out here.
 * A session closing, a draft's Discard or an access the account lost for now never deletes one.
 *
 * One Web Lock per document keeps a tab from deleting databases another tab has open: a session
 * holds it shared while it lives, a deletion takes it exclusive. A deletion that finds a hold
 * gives up (`clear`) or, at sign-out, waits for the tab holding it to let go (`clearAll`): a
 * copy left behind is not a completed deletion.
 */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { type CrossContextLockManager, deferred, nativeLocks } from "../cross-context-locks";
import { treeListCopyPrefix } from "../tree-list/copy-names";

const LIVE_PREFIX = `meridian:document:${collabSchemaKeyTag()}:live/`;
const DRAFT_PREFIX = `meridian:document:${collabSchemaKeyTag()}:draft/`;
const HOLD_WAIT_MS = 10_000;

export function documentSessionPersistenceKey(accountId: AccountId, documentId: DocumentId) {
  return `${LIVE_PREFIX}${encodeURIComponent(accountId)}/${encodeURIComponent(documentId)}`;
}

/** A draft room's copy: under its account and the document it drafts, so a purge of the document finds it. */
export function draftRoomPersistenceKey(
  accountId: AccountId,
  documentId: DocumentId,
  roomKey: string,
) {
  return `${DRAFT_PREFIX}${encodeURIComponent(accountId)}/${encodeURIComponent(documentId)}/${encodeURIComponent(roomKey)}`;
}

export type CopyHold = { release(): void };

/** The document a database name belongs to, for one account; null for another account's or another kind of database. */
function documentOf(name: string, accountId: AccountId): DocumentId | null {
  for (const prefix of [LIVE_PREFIX, DRAFT_PREFIX]) {
    const head = `${prefix}${encodeURIComponent(accountId)}/`;
    if (name.startsWith(head))
      return decodeURIComponent(name.slice(head.length).split("/")[0] ?? "") as DocumentId;
  }
  return null;
}

export class LocalDocumentCopies {
  /** The documents with a copy here: read from the browser once, then kept as sessions open and copies go. */
  private known: Set<DocumentId> | null = null;
  private readonly loading: Promise<void>;
  private readonly observers = new Set<(documents: ReadonlySet<DocumentId>) => void>();

  constructor(
    private readonly accountId: AccountId,
    private readonly locks: CrossContextLockManager | null = nativeLocks(),
    private readonly idb: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB,
  ) {
    this.loading = this.names().then((names) => {
      const found = new Set(names.flatMap((name) => documentOf(name, accountId) ?? []));
      this.known = new Set([...found, ...(this.known ?? [])]);
      this.publish();
    });
    this.loading.catch((error: unknown) => reportError(error));
  }

  private lockName(documentId: DocumentId) {
    return `meridian:local-copy:v1:${encodeURIComponent(this.accountId)}/${encodeURIComponent(documentId)}`;
  }

  private publish() {
    if (!this.known) return;
    for (const observer of this.observers) observer(this.known);
  }

  /** Calls `observer` with the documents that have a copy, once they are known and at each change. */
  observe(observer: (documents: ReadonlySet<DocumentId>) => void): () => void {
    this.observers.add(observer);
    if (this.known) observer(this.known);
    return () => this.observers.delete(observer);
  }

  /** Shared hold while a session has the document's copy open; release it once the session is destroyed. */
  async hold(documentId: DocumentId): Promise<CopyHold> {
    this.known = new Set([...(this.known ?? []), documentId]);
    this.publish();
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
   * Deletes every copy of the document. False when another tab holds one open: that tab's own
   * reading of the list clears it, and a copy left behind is found at the next start.
   */
  async clear(documentId: DocumentId): Promise<boolean> {
    if (!this.locks) {
      await this.deleteCopies(documentId);
      return true;
    }
    return this.locks.request(
      this.lockName(documentId),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) return false;
        await this.deleteCopies(documentId);
        return true;
      },
    );
  }

  /** Deletes every copy of the account, waiting for the tabs that hold one; false when one was still held after the wait. */
  async clearAll(): Promise<boolean> {
    const documents = new Set(
      (await this.names()).flatMap((name) => documentOf(name, this.accountId) ?? []),
    );
    const results = await Promise.all(
      [...documents].map(async (documentId) => {
        if (!this.locks) {
          await this.deleteCopies(documentId);
          return true;
        }
        try {
          return await this.locks.request(
            this.lockName(documentId),
            { mode: "exclusive", signal: AbortSignal.timeout(HOLD_WAIT_MS) },
            async () => {
              await this.deleteCopies(documentId);
              return true;
            },
          );
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === "TimeoutError") return false;
          if (cause instanceof DOMException && cause.name === "AbortError") return false;
          throw cause;
        }
      }),
    );
    // The account's lists go with its documents: they hold its tree and records not yet sent.
    const prefix = treeListCopyPrefix(this.accountId);
    await Promise.all(
      (await this.names())
        .filter((name) => name.startsWith(prefix))
        .map((name) => this.deleteDatabase(name)),
    );
    return results.every(Boolean);
  }

  private async deleteCopies(documentId: DocumentId) {
    const names = (await this.names()).filter(
      (name) => documentOf(name, this.accountId) === documentId,
    );
    await Promise.all(names.map((name) => this.deleteDatabase(name)));
    if (this.known?.delete(documentId)) this.publish();
  }

  private async names(): Promise<string[]> {
    if (!this.idb?.databases) return [];
    return (await this.idb.databases()).flatMap(({ name }) => (name ? [name] : []));
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

/** The accounts that have a copy in this browser. */
async function accountsWithCopies(idb: IDBFactory): Promise<AccountId[]> {
  const names = (await idb.databases?.()) ?? [];
  const accounts = new Set<AccountId>();
  for (const { name } of names) {
    const prefix = [LIVE_PREFIX, DRAFT_PREFIX].find((each) => name?.startsWith(each));
    if (!name || !prefix) continue;
    const account = name.slice(prefix.length).split("/")[0];
    if (account) accounts.add(decodeURIComponent(account) as AccountId);
  }
  return [...accounts];
}

/** Deletes every copy of an account, waiting for the tabs that hold one; returns whether none was left. */
export function clearAccountCopies(accountId: AccountId): Promise<boolean> {
  return new LocalDocumentCopies(accountId).clearAll();
}

/** Deletes the copies of every account but this one: the browser's last user was someone else. */
export async function clearCopiesOfOtherAccounts(current: AccountId): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const others = (await accountsWithCopies(indexedDB)).filter((account) => account !== current);
  await Promise.all(others.map(clearAccountCopies));
}
