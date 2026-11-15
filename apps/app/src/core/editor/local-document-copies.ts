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
 * A copy records each notice from it the writer is done with (`recordHandedBack`, on Copy or
 * Dismiss): exactly the items that notice offered. Another tab can still hold the copy and write
 * into it, so the copy can outlive the notice, and every later read of it, in any tab or after a
 * reload, subtracts the records (`offer`). A notice with words also records what it offered as
 * it shows (`recordOffered`): until the writer acts on it, the copy is never deleted, not even when
 * its document is gone for good (`clear` retires it), and each start of the account offers it
 * again from the copy (`openUnacted`), so the toast is never the only place its words are.
 */
import type { AccountId } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { type CrossContextLockManager, deferred, nativeLocks } from "../cross-context-locks";
import { treeListCopyPrefix } from "../tree-list/copy-names";
import type { UnsentTypingCause } from "./document-session-registry";
import { addList, hasMoreThan, listOf, type RangeList, type Ranges } from "./item-ranges";
import { documentText, readCopy } from "./rescued-text";

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
const HANDED_BACK_PREFIX = "meridian:handed-back:";
const OFFERED_PREFIX = "meridian:offered:";
const RETIRED_KEY = "meridian:retired";

/** What a notice with words offered from the copy, written as it shows (`recordOffered`). */
export type OfferedRecord = { id: string; cause: UnsentTypingCause; ranges: Ranges };

/** What a copy's `custom` store says about its notices. */
export type CopyRecords = {
  /** The notices from it the writer acted on (`recordHandedBack`), as one set. */
  handedBack: Ranges;
  /** Its notices with words, acted on or not. */
  offered: OfferedRecord[];
  /** Its document can never come back (`clear`): it goes once nothing it offered is unacted. */
  retired: boolean;
};

const keyRange = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}\uffff`);

function readRecords(database: IDBDatabase): Promise<CopyRecords> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("custom", "readonly");
    const store = transaction.objectStore("custom");
    const handedBack = store.getAll(keyRange(HANDED_BACK_PREFIX));
    const offeredKeys = store.getAllKeys(keyRange(OFFERED_PREFIX));
    const offered = store.getAll(keyRange(OFFERED_PREFIX));
    const retired = store.get(RETIRED_KEY);
    transaction.oncomplete = () => {
      const records: CopyRecords = {
        handedBack: new Map(),
        offered: [],
        retired: retired.result === true,
      };
      for (const record of handedBack.result as RangeList[]) addList(records.handedBack, record);
      (offered.result as Array<{ cause: UnsentTypingCause; ranges: RangeList }>).forEach(
        ({ cause, ranges: list }, index) => {
          const ranges: Ranges = new Map();
          addList(ranges, list);
          const key = String(offeredKeys.result[index]);
          records.offered.push({ id: key.slice(OFFERED_PREFIX.length), cause, ranges });
        },
      );
      resolve(records);
    };
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Notice record read aborted"));
  });
}

/** Whether some notice offered words the writer has not acted on. */
function unacted({ offered, handedBack }: CopyRecords): boolean {
  return offered.some(({ ranges }) => hasMoreThan(ranges, handedBack));
}

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

function putRecord(database: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("custom", "readwrite");
    transaction.objectStore("custom").put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Notice record write aborted"));
  });
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

/** What a copy holds, read whole. */
export type CopyContents = CopyRecords & {
  /** Everything the copy holds. */
  update: Uint8Array;
};

/** A copy no tab held, read whole; it stays locked until `finish`. */
export type UnheldCopy = CopyContents & {
  /** Its database name. */
  name: string;
  /** Releases the copy, deleting it unless `keep`; a kept one first records `acted` as notices the writer is done with. */
  finish(keep: boolean, acted?: ReadonlyMap<string, Ranges>): Promise<void>;
};

/** Reads the database `name`, under a hold that keeps it; null when it is gone, and none is created. */
async function load(idb: IDBFactory, name: string): Promise<CopyContents | null> {
  const records = await withExisting(idb, name, readRecords);
  if (!records) return null;
  const document = new Y.Doc();
  const persistence = new IndexeddbPersistence(name, document);
  try {
    await persistence.whenSynced;
    return { ...records, update: Y.encodeStateAsUpdate(document) };
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
    const opened = await Promise.all(older.map((name) => this.openIfUnheld(name, () => true)));
    return opened.filter((copy) => copy !== null);
  }

  /**
   * The account's copies no tab holds that have words a notice offered and the writer has not
   * acted on, each locked until `finish`: what the account's start offers again, wherever its
   * document is. A retired copy with nothing left unacted goes on the way.
   */
  async openUnacted(): Promise<UnheldCopy[]> {
    const names = (await this.names()).filter((name) => documentOf(name, this.accountId));
    const opened = await Promise.all(names.map((name) => this.openIfUnheld(name, unacted)));
    return opened.filter((copy) => copy !== null);
  }

  /**
   * The copy `name` under its exclusive lock, read whole when `wanted` says so from its records;
   * null when a tab holds it, it is gone, or it is not wanted (then released, or deleted when it
   * is retired with nothing left unacted).
   */
  private async openIfUnheld(
    name: string,
    wanted: (records: CopyRecords) => boolean,
  ): Promise<UnheldCopy | null> {
    const { locks, idb } = this;
    if (!locks || !idb) return null;
    const ready = deferred<UnheldCopy | null>();
    const finished = deferred<{ keep: boolean; acted: ReadonlyMap<string, Ranges> }>();
    void locks
      .request(this.lockName(name), { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock) return ready.resolve(null);
        const records = await withExisting(idb, name, readRecords);
        if (!records || !wanted(records)) {
          ready.resolve(null);
          if (records?.retired && !unacted(records)) await this.deleteDatabase(name);
          return;
        }
        const contents = await load(idb, name);
        if (!contents) return ready.resolve(null);
        ready.resolve({
          name,
          ...contents,
          finish: async (keep, acted = new Map()) => finished.resolve({ keep, acted }),
        });
        const { keep, acted } = await finished.promise;
        if (!keep) return this.deleteDatabase(name);
        for (const [id, ranges] of acted)
          await withExisting(idb, name, (database) =>
            putRecord(database, `${HANDED_BACK_PREFIX}${id}`, listOf(ranges)),
          );
      })
      .catch(ready.reject);
    return ready.promise;
  }

  /**
   * `value` under `key` in the copy `name`'s records, under its shared lock; a copy already
   * deleted is not created again. Resolves to its records after.
   */
  private async record(name: string, key: string, value: unknown): Promise<CopyRecords | null> {
    const idb = this.idb;
    if (!idb) return null;
    // No database: it was deleted, and with it everything the record would cover.
    const write = () =>
      withExisting(idb, name, async (database) => {
        await putRecord(database, key, value);
        return readRecords(database);
      });
    return this.locks
      ? this.locks.request(this.lockName(name), { mode: "shared" }, write)
      : write();
  }

  /**
   * Records in the copy `name` what the notice `id` offered, as it shows: until the writer acts
   * on it (`recordHandedBack`), the copy is kept and every start of the account offers it again.
   */
  async recordOffered(
    name: string,
    id: string,
    cause: UnsentTypingCause,
    ranges: Ranges,
  ): Promise<void> {
    await this.record(name, `${OFFERED_PREFIX}${id}`, { cause, ranges: listOf(ranges) });
  }

  /**
   * Records in the copy `name` that the writer is done with the notice `id`, which offered
   * exactly `offered`, so no later read, in any tab or after a reload, offers it again. Taken
   * under the copy's shared lock, so a tab reading it to delete sees the record or has deleted
   * it. A retired copy with nothing left unacted then goes, unless a tab holds it.
   */
  async recordHandedBack(name: string, id: string, offered: Ranges): Promise<void> {
    const records = await this.record(name, `${HANDED_BACK_PREFIX}${id}`, listOf(offered));
    if (records?.retired && !unacted(records)) await this.openIfUnheld(name, () => false);
  }

  /** The notices from the copy `name` the writer acted on; read by a session that holds it. */
  async handedBack(name: string): Promise<Ranges> {
    const records = this.idb && (await withExisting(this.idb, name, readRecords));
    return records?.handedBack ?? new Map();
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
          const copy = await load(idb, name);
          return copy && readCopy(copy.update, documentText);
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
   * Deletes every copy of the document, which can never come back. A copy with words a notice
   * offered that the writer has not acted on is retired instead, and goes once they are
   * (`recordHandedBack`, `openIfUnheld`). False when another tab holds one open: that tab's own
   * reading of the list clears it, and a copy left behind is found at the next start.
   */
  async clear(documentId: DocumentId): Promise<boolean> {
    const names = await this.namesOf(documentId);
    if (!this.locks) {
      await this.retireCopies(documentId, names);
      return true;
    }
    return (
      (await this.exclusively(names, { ifAvailable: true }, async () => {
        await this.retireCopies(documentId, names);
        return true;
      })) ?? false
    );
  }

  private async retireCopies(documentId: DocumentId, names: readonly string[]) {
    const idb = this.idb;
    const retired = new Set<string>();
    if (idb)
      for (const name of names)
        await withExisting(idb, name, async (database) => {
          if (!unacted(await readRecords(database))) return;
          retired.add(name);
          await putRecord(database, RETIRED_KEY, true);
        });
    await this.deleteCopies(
      documentId,
      names.filter((name) => !retired.has(name)),
      retired,
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

  /** `kept`: the document's copies that stay; their rooms keep their pointers, and the document stays known. */
  private async deleteCopies(
    documentId: DocumentId,
    names: readonly string[],
    kept: ReadonlySet<string> = new Set(),
  ) {
    await Promise.all(names.map((name) => this.deleteDatabase(name)));
    const keptKeys = new Set([...kept].map((name) => parseName(name).key));
    for (const { key } of names.map(parseName))
      if (!keptKeys.has(key)) this.pointers.removeItem(`${POINTER_PREFIX}${key}`);
    if (kept.size === 0 && this.known?.delete(documentId)) this.publish();
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
