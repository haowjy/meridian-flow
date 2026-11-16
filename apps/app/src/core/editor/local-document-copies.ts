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
 *
 * A copy is working storage only: what a notice offered from it and whether the writer acted on
 * it are in the account's notice store (`hand-back-notices.ts`). What the server is known to have
 * is in the copy, its mark (`server-mark.ts`): a copy is deleted only once what it holds beyond its
 * mark is claimed (`clear`), and kept when the claim can't be stored.
 */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { browserStorage, type RecordStorage } from "@/client/storage/browser-record";
import { type CrossContextLockManager, deferred, nativeLocks } from "../cross-context-locks";
import { treeListCopyPrefix } from "../tree-list/copy-names";
import { HAND_BACK_NOTICES_PREFIX, handBackNoticesName } from "./hand-back-notices";
import type { Ranges } from "./item-ranges";
import { documentText, readCopy } from "./rescued-text";
import { beyondMark, SERVER_MARK_KEY } from "./server-mark";

const LIVE_PREFIX = `meridian:document:${collabSchemaKeyTag()}:live/`;
const DRAFT_PREFIX = `meridian:document:${collabSchemaKeyTag()}:draft/`;
const HOLD_WAIT_MS = 10_000;

/** `#` is always encoded in the parts of a key, so it only ever starts an incarnation number. */
export function incarnationName(key: string, incarnation: number): string {
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
/** Opens the database `name` if it exists; null when it does not, and none is created. */
function openExisting(idb: IDBFactory, name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = idb.open(name);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onerror = () => {
      if (request.error?.name === "AbortError") resolve(null);
      else reject(request.error ?? new Error("IndexedDB open failed"));
    };
    request.onsuccess = () => resolve(request.result);
  });
}

/** `use` on the database `name` if it exists, closed after; null when it does not, and none is created. */
async function withExisting<T>(
  idb: IDBFactory,
  name: string,
  use: (database: IDBDatabase) => Promise<T>,
): Promise<T | null> {
  const database = await openExisting(idb, name);
  if (!database) return null;
  try {
    return await use(database);
  } finally {
    database.close();
  }
}

export type CopyHold = { release(): void };

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

const NO_MARK = Y.encodeStateVector(new Map());

/** A copy's items beyond its mark, and the copy they are read from. */
export type BeyondMark = { update: Uint8Array; lacking: Ranges };

function markedBeyond(
  loaded: { update: Uint8Array; mark: Uint8Array | null } | null,
): BeyondMark | null {
  if (!loaded) return null;
  // No mark proves nothing the server holds (a copy written before marks, or a first write lost):
  // the whole copy is offered.
  const lacking = beyondMark(loaded.update, loaded.mark ?? NO_MARK);
  return lacking.size > 0 ? { update: loaded.update, lacking } : null;
}

/** A copy no tab held, read whole; it stays locked until `finish`. */
export type UnheldCopy = {
  /** Its database name. */
  name: string;
  /** Everything the copy holds. */
  update: Uint8Array;
  /** Releases the copy, deleting it unless `keep`. */
  finish(keep: boolean): Promise<void>;
};

/**
 * Everything the database `name` holds, and its mark; read under a hold that keeps it. Null when
 * it is gone, and none is created.
 */
async function load(
  idb: IDBFactory,
  name: string,
): Promise<{ update: Uint8Array; mark: Uint8Array | null } | null> {
  if (!(await withExisting(idb, name, async () => true))) return null;
  const document = new Y.Doc();
  const persistence = new IndexeddbPersistence(name, document);
  try {
    await persistence.whenSynced;
    const mark: unknown = await persistence.get(SERVER_MARK_KEY);
    return {
      update: Y.encodeStateAsUpdate(document),
      mark: mark instanceof Uint8Array ? mark : null,
    };
  } finally {
    await persistence.destroy();
    document.destroy();
  }
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
    /** Where each room's current incarnation is recorded, for every tab of the browser. */
    private readonly pointers: RecordStorage = browserStorage("local") ?? memoryStorage(),
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
  async openOlder(key: string, current: number): Promise<UnheldCopy[]> {
    const older = (await this.names()).filter((name) => {
      const parsed = parseName(name);
      return parsed.key === key && parsed.incarnation < current;
    });
    const opened = await Promise.all(older.map((name) => this.openIfUnheld(name)));
    return opened.filter((copy) => copy !== null);
  }

  /** The copy `name` read whole under its exclusive lock; null when a tab holds it or it is gone. */
  private async openIfUnheld(name: string): Promise<UnheldCopy | null> {
    const { locks, idb } = this;
    if (!locks || !idb) return null;
    const ready = deferred<UnheldCopy | null>();
    const finished = deferred<boolean>();
    void locks
      .request(this.lockName(name), { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock) return ready.resolve(null);
        const loaded = await load(idb, name);
        if (!loaded) return ready.resolve(null);
        ready.resolve({
          name,
          update: loaded.update,
          finish: async (keep) => finished.resolve(keep),
        });
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
    if (!this.locks) return { release: () => undefined };
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
    };
  }

  /**
   * The words this browser holds of the document, read from its rooms' current copies (live, or a
   * Work's draft room) under a shared hold, so no tab deletes one while it is read; the longest
   * wins. Null with none.
   */
  async text(documentId: DocumentId): Promise<string | null> {
    const idb = this.idb;
    const names = (await this.names()).filter((name) => {
      const { key, incarnation } = parseName(name);
      return documentOf(name, this.accountId) === documentId && incarnation === this.current(key);
    });
    if (!idb || names.length === 0) return null;
    const holds = await Promise.all(names.map((name) => this.hold(name)));
    try {
      const texts = await Promise.all(
        names.map(async (name) => {
          const loaded = await load(idb, name);
          return loaded && readCopy(loaded.update, documentText);
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
   * What the copy `name` holds beyond its mark, read under a shared hold; null when it is gone or
   * holds nothing beyond it.
   */
  async beyondMark(name: string): Promise<BeyondMark | null> {
    const idb = this.idb;
    if (!idb) return null;
    const hold = await this.hold(name);
    try {
      return markedBeyond(await load(idb, name));
    } finally {
      hold.release();
    }
  }

  /**
   * Deletes every copy of the document, which can never come back, once `claim` has stored what
   * each holds beyond its mark; a copy whose claim fails stays, and the next start claims it again.
   * False when another tab holds one open: that tab's own
   * reading of the list clears it, and a copy left behind is found at the next start.
   */
  async clear(
    documentId: DocumentId,
    claim: (name: string, beyond: BeyondMark) => Promise<boolean>,
  ): Promise<boolean> {
    return this.claimAndDelete(documentId, await this.namesOf(documentId), claim, true);
  }

  /** The names of this account's draft copies (every incarnation) with the draft room and document each belongs to. */
  async draftCopies(): Promise<{ name: string; roomKey: string; documentId: DocumentId }[]> {
    const head = `${DRAFT_PREFIX}${encodeURIComponent(this.accountId)}/`;
    return (await this.names()).flatMap((name) => {
      if (!name.startsWith(head)) return [];
      const [, documentId, roomKey] = parseName(name).key.slice(DRAFT_PREFIX.length).split("/");
      return documentId && roomKey
        ? [
            {
              name,
              roomKey: decodeURIComponent(roomKey),
              documentId: decodeURIComponent(documentId) as DocumentId,
            },
          ]
        : [];
    });
  }

  /** `clear` for the draft copies `names` of one document: the document's other copies stay. */
  async clearDraftCopies(
    documentId: DocumentId,
    names: readonly string[],
    claim: (name: string, beyond: BeyondMark) => Promise<boolean>,
  ): Promise<boolean> {
    return this.claimAndDelete(documentId, names, claim, false);
  }

  private async claimAndDelete(
    documentId: DocumentId,
    names: readonly string[],
    claim: (name: string, beyond: BeyondMark) => Promise<boolean>,
    whole: boolean,
  ): Promise<boolean> {
    const run = async () => {
      const claimed = await Promise.all(
        names.map(async (name) => {
          const beyond = this.idb && markedBeyond(await load(this.idb, name));
          return !beyond || (await claim(name, beyond));
        }),
      );
      const every = claimed.every(Boolean);
      const deleted = names.filter((_, index) => claimed[index]);
      await this.deleteCopies(documentId, deleted, whole && every);
      if (!whole && every)
        for (const { key } of deleted.map(parseName))
          this.pointers.removeItem(`${POINTER_PREFIX}${key}`);
      return true;
    };
    if (!this.locks) return run();
    return (await this.exclusively(names, { ifAvailable: true }, run)) ?? false;
  }

  /**
   * Deletes every copy of the account, waiting for the tabs that hold one, then its notices; false
   * when a copy was still held after the wait. The notices stay with a copy left behind: they say
   * which of its words the writer already acted on.
   */
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
    const cleared = results.every(Boolean);
    if (cleared) await this.deleteDatabase(handBackNoticesName(this.accountId));
    return cleared;
  }

  private async namesOf(documentId: DocumentId): Promise<string[]> {
    return (await this.names()).filter((name) => documentOf(name, this.accountId) === documentId);
  }

  /** `all`: no copy of the document is left, so its pointers and its place in `known` go too. */
  private async deleteCopies(documentId: DocumentId, names: readonly string[], all = true) {
    await Promise.all(names.map((name) => this.deleteDatabase(name)));
    if (!all) return;
    for (const { key } of names.map(parseName)) this.pointers.removeItem(`${POINTER_PREFIX}${key}`);
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

/** The accounts that have a copy or a notice in this browser. */
async function accountsWithCopies(idb: IDBFactory): Promise<AccountId[]> {
  const names = (await idb.databases?.()) ?? [];
  const accounts = new Set<AccountId>();
  for (const { name } of names) {
    const prefix = [LIVE_PREFIX, DRAFT_PREFIX, HAND_BACK_NOTICES_PREFIX].find((each) =>
      name?.startsWith(each),
    );
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

function memoryStorage(): RecordStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}
