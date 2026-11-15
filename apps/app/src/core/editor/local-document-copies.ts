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
 * One Web Lock per database keeps a tab from deleting a database another tab has open: a session
 * holds it shared while it lives, a deletion takes it exclusive. A deletion that finds a hold
 * gives up (`clear`) or, at sign-out, waits for the tab holding it to let go (`clearAll`): a
 * copy left behind is not a completed deletion.
 *
 * A room has one current *incarnation* of its copy: a database named by the room's key and a
 * trailing number (none means 0). A session that must stop offering what its copy holds opens the
 * next one instead of emptying the copy under the tabs that have it open: nothing is cleared, no
 * message is sent, and two tabs that advance at once both end on the same next number. A copy is
 * deleted on a final fact; an incarnation that is no longer current is deleted when no tab holds
 * it (`openOlder`).
 */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { type CrossContextLockManager, deferred, nativeLocks } from "../cross-context-locks";
import { treeListCopyPrefix } from "../tree-list/copy-names";
import { documentText } from "./rescued-text";

const LIVE_PREFIX = `meridian:document:${collabSchemaKeyTag()}:live/`;
const DRAFT_PREFIX = `meridian:document:${collabSchemaKeyTag()}:draft/`;
const HOLD_WAIT_MS = 10_000;

/** `#` is always encoded in the parts of a key, so it only ever starts an incarnation number. */
function incarnationName(key: string, incarnation: number): string {
  return incarnation === 0 ? key : `${key}#${incarnation}`;
}

function parseName(name: string): { key: string; incarnation: number } {
  const at = name.lastIndexOf("#");
  return at < 0
    ? { key: name, incarnation: 0 }
    : { key: name.slice(0, at), incarnation: Number(name.slice(at + 1)) };
}

/** A room's copy key, with no incarnation: `LocalDocumentCopies.current` says which one is open now. */
export function documentSessionPersistenceKey(accountId: AccountId, documentId: DocumentId) {
  return `${LIVE_PREFIX}${encodeURIComponent(accountId)}/${encodeURIComponent(documentId)}`;
}

/** A draft room's copy key: under its account and the document it drafts, so a purge of the document finds it. */
export function draftRoomPersistenceKey(
  accountId: AccountId,
  documentId: DocumentId,
  roomKey: string,
) {
  return `${DRAFT_PREFIX}${encodeURIComponent(accountId)}/${encodeURIComponent(documentId)}/${encodeURIComponent(roomKey)}`;
}

const POINTER_PREFIX = "meridian:copy-incarnation:";

export type CopyHold = {
  release(): void;
  /**
   * Releases the hold, then deletes the database if no tab holds it: a copy whose words were
   * handed back must not be offered again. A tab that still holds it deletes it at its own drop.
   */
  drop(): Promise<void>;
};

/** The document a database name belongs to, for one account; null for another account's or another kind of database. */
function documentOf(name: string, accountId: AccountId): DocumentId | null {
  for (const prefix of [LIVE_PREFIX, DRAFT_PREFIX]) {
    const head = `${prefix}${encodeURIComponent(accountId)}/`;
    if (name.startsWith(head))
      return decodeURIComponent(
        name.slice(head.length).split("/")[0]?.split("#")[0] ?? "",
      ) as DocumentId;
  }
  return null;
}

/** What an older incarnation held when no tab did; it stays locked until `finish`. */
export type OlderCopy = {
  /** Everything the copy holds. */
  update: Uint8Array;
  /** Releases the copy, deleting it unless `keep`. */
  finish(keep: boolean): Promise<void>;
};

export class LocalDocumentCopies {
  /** The documents with a copy here: read from the browser once, then kept as sessions open and copies go. */
  private known: Set<DocumentId> | null = null;
  private readonly loading: Promise<void>;
  private readonly observers = new Set<(documents: ReadonlySet<DocumentId>) => void>();

  constructor(
    private readonly accountId: AccountId,
    private readonly locks: CrossContextLockManager | null = nativeLocks(),
    private readonly idb: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB,
    /** Where each room's current incarnation is recorded, for every tab of the browser. */
    private readonly pointers: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    > = typeof localStorage === "undefined" ? memoryStorage() : localStorage,
  ) {
    this.loading = this.names().then((names) => {
      const found = new Set(names.flatMap((name) => documentOf(name, accountId) ?? []));
      this.known = new Set([...found, ...(this.known ?? [])]);
      this.publish();
    });
    this.loading.catch((error: unknown) => reportError(error));
  }

  private lockName(name: string) {
    return `meridian:local-copy:v2:${name}`;
  }

  /** The incarnation of the room's copy that sessions open now. Synchronous: a session is made where it is needed. */
  current(key: string): number {
    return Number(this.pointers.getItem(`${POINTER_PREFIX}${key}`) ?? 0);
  }

  /** The database name of the room's current incarnation. */
  nameOf(key: string): string {
    return incarnationName(key, this.current(key));
  }

  /**
   * Moves the room to the incarnation after `from`, unless some tab already did. Two tabs that
   * advance from n both end on n + 1 and are peers there. Resolves to the current incarnation.
   */
  async advance(key: string, from: number): Promise<number> {
    const move = () => {
      if (this.current(key) <= from)
        this.pointers.setItem(`${POINTER_PREFIX}${key}`, String(from + 1));
      return this.current(key);
    };
    // Its own lock: a session holds its copy's lock for its whole life.
    return this.locks
      ? this.locks.request(`meridian:copy-advance:${key}`, { mode: "exclusive" }, move)
      : move();
  }

  /**
   * The room's older incarnations that no tab holds, each locked until `finish`: a session that
   * opens the current incarnation reads what they held against its first handshake before they go.
   */
  async openOlder(key: string, current: number): Promise<OlderCopy[]> {
    const older = (await this.names()).filter((name) => {
      const parsed = parseName(name);
      return parsed.key === key && parsed.incarnation < current;
    });
    const opened = await Promise.all(older.map((name) => this.openIfUnheld(name)));
    return opened.filter((copy) => copy !== null);
  }

  private async openIfUnheld(name: string): Promise<OlderCopy | null> {
    if (!this.locks) return null;
    const ready = deferred<OlderCopy | null>();
    const finished = deferred<boolean>();
    void this.locks
      .request(this.lockName(name), { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock) return ready.resolve(null);
        const document = new Y.Doc();
        const persistence = new IndexeddbPersistence(name, document);
        try {
          await persistence.whenSynced;
          ready.resolve({
            update: Y.encodeStateAsUpdate(document),
            finish: async (keep) => {
              finished.resolve(keep);
            },
          });
        } finally {
          await persistence.destroy();
          document.destroy();
        }
        if (!(await finished.promise)) await this.deleteDatabase(name);
      })
      .catch(ready.reject);
    return ready.promise;
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

  /** Shared hold while a session has the database `name` open; release it once the session is destroyed. */
  async hold(name: string): Promise<CopyHold> {
    const documentId = documentOf(name, this.accountId);
    if (documentId) {
      this.known = new Set([...(this.known ?? []), documentId]);
      this.publish();
    }
    if (!this.locks) return { release: () => undefined, drop: () => this.deleteDatabase(name) };
    const acquired = deferred<void>();
    const released = deferred<void>();
    const held = this.locks.request(this.lockName(name), { mode: "shared" }, async () => {
      acquired.resolve();
      await released.promise;
    });
    held.catch(acquired.reject);
    await acquired.promise;
    return {
      release: () => released.resolve(),
      drop: async () => {
        released.resolve();
        await held;
        await this.locks?.request(
          this.lockName(name),
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            if (lock) await this.deleteDatabase(name);
          },
        );
      },
    };
  }

  /**
   * The words this browser holds of the document, read from its rooms' current copies (live, or a
   * Work's draft room) under a shared hold, so no tab deletes one while it is read; the longest
   * wins. Null with none.
   */
  async text(documentId: DocumentId): Promise<string | null> {
    const names = (await this.names()).filter((name) => {
      const { key, incarnation } = parseName(name);
      return documentOf(name, this.accountId) === documentId && incarnation === this.current(key);
    });
    if (names.length === 0) return null;
    const holds = await Promise.all(names.map((name) => this.hold(name)));
    try {
      const texts = await Promise.all(
        names.map(async (name) => {
          const document = new Y.Doc();
          const persistence = new IndexeddbPersistence(name, document);
          try {
            await persistence.whenSynced;
            return documentText(document);
          } finally {
            await persistence.destroy();
            document.destroy();
          }
        }),
      );
      return texts.reduce<string | null>(
        (longest, text) => (text && text.length > (longest?.length ?? 0) ? text : longest),
        null,
      );
    } finally {
      for (const hold of holds) hold.release();
    }
  }

  /** `run` with every one of `names` locked exclusively; undefined when `ifAvailable` and one is held. */
  private async exclusively<T>(
    names: readonly string[],
    options: { ifAvailable: true } | { signal: AbortSignal },
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    const [first, ...rest] = names;
    if (first === undefined) return run();
    const nested = async () => this.exclusively(rest, options, run);
    return this.locks?.request(
      this.lockName(first),
      { mode: "exclusive", ...options },
      async (lock) => (lock === null ? undefined : nested()),
    );
  }

  /**
   * Deletes every copy of the document. False when another tab holds one open: that tab's own
   * reading of the list clears it, and a copy left behind is found at the next start.
   */
  async clear(documentId: DocumentId): Promise<boolean> {
    const names = await this.namesOf(documentId);
    if (!this.locks) {
      await this.deleteCopies(documentId, names);
      return true;
    }
    return (
      (await this.exclusively(names, { ifAvailable: true }, async () => {
        await this.deleteCopies(documentId, names);
        return true;
      })) ?? false
    );
  }

  /** Deletes every copy of the account, waiting for the tabs that hold one; false when one was still held after the wait. */
  async clearAll(): Promise<boolean> {
    const documents = new Set(
      (await this.names()).flatMap((name) => documentOf(name, this.accountId) ?? []),
    );
    const results = await Promise.all(
      [...documents].map(async (documentId) => {
        const names = await this.namesOf(documentId);
        if (!this.locks) {
          await this.deleteCopies(documentId, names);
          return true;
        }
        try {
          return await this.exclusively(
            names,
            { signal: AbortSignal.timeout(HOLD_WAIT_MS) },
            async () => {
              await this.deleteCopies(documentId, names);
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

  private async namesOf(documentId: DocumentId): Promise<string[]> {
    return (await this.names()).filter((name) => documentOf(name, this.accountId) === documentId);
  }

  private async deleteCopies(documentId: DocumentId, names: readonly string[]) {
    await Promise.all(names.map((name) => this.deleteDatabase(name)));
    for (const name of names) this.pointers.removeItem(`${POINTER_PREFIX}${parseName(name).key}`);
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

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}
