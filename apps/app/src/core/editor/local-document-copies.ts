/**
 * This browser's local copies of one account's documents: the IndexedDB databases
 * a session persists a document into, named by the account and the document id. The registry
 * holds one inventory per account, whoever has a view of the document: a copy is found and
 * deleted by its document id.
 *
 * A copy is deleted only on a fact that is final (`list-removal-observer`: the node's purge, its
 * Work or chat purged, the account removed from the project) or when the account signs out here.
 * A session closing or an access the account lost for now never deletes one.
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
 * A copy is working storage only (`local-copy-store.ts`). What the server is known to have is in
 * the copy, its mark (`SERVER_META`): what it holds beyond its mark is what a room that ends for
 * good drops.
 */
import type { DraftId } from "@meridian/contracts";
import type { AccountId, DocumentRoom } from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import { browserStorage, type RecordStorage } from "@/client/storage/browser-record";
import { type CrossContextLockManager, deferred, nativeLocks } from "../cross-context-locks";
import { treeListCopyPrefix } from "../tree-list/copy-names";
import { type LoadedCopy, openCopyDatabase, readCopy } from "./local-copy-store";
import { storedWordsBeyond } from "./unsent-words";

const LIVE_PREFIX = `meridian:loro:${collabSchemaKeyTag()}:live/`;
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

/**
 * A room's copy key, with no incarnation: `LocalDocumentCopies.current` says which one is open now.
 * A fork room's copy is named under its document's, so the document's copies are its Live copy and
 * every fork copy of it, found and deleted together.
 */
export function documentSessionPersistenceKey(accountId: AccountId, room: DocumentRoom) {
  const live = `${LIVE_PREFIX}${encodeURIComponent(accountId)}/${encodeURIComponent(room.documentId)}`;
  return room.kind === "live" ? live : `${live}/fork/${encodeURIComponent(room.draftId)}`;
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

function roomOf(name: string, accountId: AccountId): DocumentRoom | null {
  const head = `${LIVE_PREFIX}${encodeURIComponent(accountId)}/`;
  const { key } = parseName(name);
  if (!key.startsWith(head)) return null;
  const [document, fork, draft, ...rest] = key.slice(head.length).split("/");
  if (!document || rest.length > 0) return null;
  const documentId = decodeURIComponent(document) as DocumentId;
  if (fork === undefined) return { kind: "live", documentId };
  return fork === "fork" && draft
    ? { kind: "fork", draftId: decodeURIComponent(draft) as DraftId, documentId }
    : null;
}

export type UnheldCopy = {
  name: string;
  loaded: LoadedCopy;
  finish(): Promise<void>;
};

async function load(idb: IDBFactory, name: string): Promise<LoadedCopy | null> {
  if (!(await withExisting(idb, name, async () => true))) return null;
  const database = await openCopyDatabase(idb, name);
  try {
    return await readCopy(database);
  } finally {
    database.close();
  }
}

export class LocalDocumentCopies {
  private known: Set<DocumentId> | null = null;
  private readonly loading: Promise<void>;
  private readonly observers = new Set<(documents: ReadonlySet<DocumentId>) => void>();

  constructor(
    private readonly accountId: AccountId,
    private readonly locks: CrossContextLockManager | null = nativeLocks(),
    private readonly idb: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB,
    private readonly pointers: RecordStorage = browserStorage("local") ?? memoryStorage(),
  ) {
    this.loading = this.names().then((names) => {
      const found = new Set(names.flatMap((name) => roomOf(name, accountId)?.documentId ?? []));
      this.known = new Set([...found, ...(this.known ?? [])]);
      this.publish();
    });
    this.loading.catch((error: unknown) => reportError(error));
  }

  private lockName(name: string) {
    return `meridian:local-copy:v2:${name}`;
  }

  current(key: string): number {
    return Number(this.pointers.getItem(`${POINTER_PREFIX}${key}`) ?? 0);
  }

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

  async openOlder(key: string, current: number): Promise<UnheldCopy[]> {
    const older = (await this.names()).filter((name) => {
      const parsed = parseName(name);
      return parsed.key === key && parsed.incarnation < current;
    });
    const opened = await Promise.all(older.map((name) => this.openIfUnheld(name)));
    return opened.filter((copy) => copy !== null);
  }

  private async openIfUnheld(name: string): Promise<UnheldCopy | null> {
    const { locks, idb } = this;
    if (!locks || !idb) return null;
    const ready = deferred<UnheldCopy | null>();
    const finished = deferred<void>();
    void locks
      .request(this.lockName(name), { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (!lock) return ready.resolve(null);
        const loaded = await load(idb, name);
        if (!loaded) return ready.resolve(null);
        ready.resolve({ name, loaded, finish: async () => finished.resolve() });
        await finished.promise;
        await this.deleteDatabase(name);
      })
      .catch(ready.reject);
    return ready.promise;
  }

  private publish() {
    if (!this.known) return;
    for (const observer of this.observers) observer(this.known);
  }

  observe(observer: (documents: ReadonlySet<DocumentId>) => void): () => void {
    this.observers.add(observer);
    if (this.known) observer(this.known);
    return () => this.observers.delete(observer);
  }

  async currentCopies(): Promise<{ name: string; room: DocumentRoom }[]> {
    return (await this.names()).flatMap((name) => {
      const room = roomOf(name, this.accountId);
      const { key, incarnation } = parseName(name);
      return room && incarnation === this.current(key) ? [{ name, room }] : [];
    });
  }

  async hold(name: string): Promise<CopyHold> {
    const documentId = roomOf(name, this.accountId)?.documentId;
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

  async holds(name: string, beyondMark: (loaded: LoadedCopy) => boolean): Promise<boolean> {
    const idb = this.idb;
    if (!idb) return false;
    const hold = await this.hold(name);
    try {
      const loaded = await load(idb, name);
      return loaded !== null && beyondMark(loaded);
    } finally {
      hold.release();
    }
  }

  async clear(documentId: DocumentId, drop: () => void): Promise<boolean> {
    const names = await this.namesOf(documentId);
    const run = async () => {
      await Promise.all(
        names.map(async (name) => {
          const loaded = this.idb && (await load(this.idb, name));
          if (loaded && storedWordsBeyond(loaded)) drop();
        }),
      );
      await this.deleteCopies(documentId, names);
      return true;
    };
    if (!this.locks) return run();
    return (await this.exclusively(names, { ifAvailable: true }, run)) ?? false;
  }

  async clearAll(): Promise<boolean> {
    // Before any deletion: from here an account lifetime that began earlier, in any tab, opens no
    // copy, so none is re-created behind it.
    countSignOut(this.accountId);
    const documents = new Set(
      (await this.names()).flatMap((name) => roomOf(name, this.accountId)?.documentId ?? []),
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
    const prefix = treeListCopyPrefix(this.accountId);
    await Promise.all(
      (await this.names())
        .filter((name) => name.startsWith(prefix))
        .map((name) => this.deleteDatabase(name)),
    );
    return results.every(Boolean);
  }

  private async namesOf(documentId: DocumentId): Promise<string[]> {
    return (await this.names()).filter(
      (name) => roomOf(name, this.accountId)?.documentId === documentId,
    );
  }

  private async deleteCopies(documentId: DocumentId, names: readonly string[]) {
    await Promise.all(names.map((name) => this.deleteDatabase(name)));
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

async function accountsWithCopies(idb: IDBFactory): Promise<AccountId[]> {
  const names = (await idb.databases?.()) ?? [];
  const accounts = new Set<AccountId>();
  for (const { name } of names) {
    if (!name?.startsWith(LIVE_PREFIX)) continue;
    const account = name.slice(LIVE_PREFIX.length).split("/")[0];
    if (account) accounts.add(decodeURIComponent(account) as AccountId);
  }
  return [...accounts];
}

const SIGN_OUTS_PREFIX = "meridian:sign-outs:";

function signOuts(accountId: string): number {
  return Number(browserStorage("local")?.getItem(`${SIGN_OUTS_PREFIX}${accountId}`) ?? 0);
}

function countSignOut(accountId: string): void {
  browserStorage("local")?.setItem(
    `${SIGN_OUTS_PREFIX}${accountId}`,
    String(signOuts(accountId) + 1),
  );
}

export function copiesOpenSince(accountId: string): () => boolean {
  const at = signOuts(accountId);
  return () => signOuts(accountId) === at;
}

export function clearAccountCopies(accountId: AccountId): Promise<boolean> {
  return new LocalDocumentCopies(accountId).clearAll();
}

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
