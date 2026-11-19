/**
 * The account's hand-back notices: words a room could not deliver, kept with the notice that
 * offers them, apart from the copies they came from. One IndexedDB database per account, one
 * store. Two writes exist and neither can undo the other: `claim` adds a notice under a new id,
 * `act` marks one acted on, keeping its items. Each is one transaction, run one at a time across
 * tabs, so two tabs holding the same words get one notice between them. Nothing is deleted but
 * the whole database, at sign-out.
 */
import type { AccountId } from "@meridian/contracts/protocol";
import { openIndexedDbDatabase, settled } from "../indexeddb-database";
import type { UnsentTypingCause } from "./document-session-registry";
import { addList, listOf, type RangeList, type Ranges, subtract } from "./item-ranges";

const NOTICES = "notices";
const BY_COPY = "copy";
const UNACTED = "unacted";
export const HAND_BACK_NOTICES_PREFIX = "meridian-handback:";

export function handBackNoticesName(accountId: AccountId): string {
  return `${HAND_BACK_NOTICES_PREFIX}${encodeURIComponent(accountId)}`;
}

export type HandBackNotice = Readonly<{
  id: string;
  /** The database name of the copy incarnation its words came from. */
  copy: string;
  cause: UnsentTypingCause;
  /** The Yjs items whose words it holds. */
  ranges: RangeList;
  text: string;
}>;

/**
 * An unacted notice carries `unacted`, which the sparse `unacted` index lists. Acting drops it
 * and the words, keeping the items: a claim still pending somewhere (a retiring session's, in
 * any tab) must find them held, and nothing can tell when the last such claim has run.
 */
type Stored = HandBackNotice & { unacted: 1 };
type Acted = Pick<HandBackNotice, "id" | "copy" | "ranges">;

export interface HandBackNotices {
  /**
   * Of `lacking`, the items no notice from `copy` holds yet become a new notice with the words
   * `read` finds in them; null when they have none. `read` runs inside the transaction, so it
   * must be synchronous. Resolves once the notice is stored; rejects, storing nothing, when it
   * can't be.
   */
  claim(
    copy: string,
    cause: UnsentTypingCause,
    lacking: Ranges,
    read: (ranges: Ranges) => string | null,
  ): Promise<HandBackNotice | null>;
  /** The words reached the clipboard: the notice is acted on, for good. Rejects when it can't be stored. */
  act(id: string): Promise<void>;
  /** Every notice not acted on. */
  unacted(): Promise<HandBackNotice[]>;
  /** Calls `listener` when another tab of the account claimed or acted on a notice. */
  subscribe(listener: () => void): () => void;
  close(): void;
}

export function createHandBackNotices(accountId: AccountId): HandBackNotices {
  const name = handBackNoticesName(accountId);
  if (typeof indexedDB === "undefined") return unavailableNotices();
  const database = openIndexedDbDatabase(name, (db) => {
    const store = db.createObjectStore(NOTICES, { keyPath: "id" });
    store.createIndex(BY_COPY, BY_COPY);
    store.createIndex(UNACTED, UNACTED);
  });
  let channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(name);
  const listeners = new Set<() => void>();
  if (channel)
    channel.onmessage = () => {
      for (const listener of [...listeners]) listener();
    };
  // A claim begun before `close` still commits; only the other tabs' re-read is skipped.
  const changed = () => channel?.postMessage(null);

  return {
    async claim(copy, cause, lacking, read) {
      const notice = await database.transact([NOTICES], "readwrite", async (tx) => {
        const store = tx.objectStore(NOTICES);
        const earlier = await settled<Acted[]>(store.index(BY_COPY).getAll(copy));
        const held: Ranges = new Map();
        for (const each of earlier) addList(held, each.ranges);
        const ranges = subtract(lacking, held);
        const text = ranges.size > 0 ? read(ranges) : null;
        if (text === null) return null;
        const made: HandBackNotice = {
          id: crypto.randomUUID(),
          copy,
          cause,
          ranges: listOf(ranges),
          text,
        };
        store.add({ ...made, unacted: 1 } satisfies Stored);
        return made;
      });
      if (notice) changed();
      return notice;
    },
    async act(id) {
      await database.transact([NOTICES], "readwrite", async (tx) => {
        const store = tx.objectStore(NOTICES);
        const notice = await settled<Stored | Acted | undefined>(store.get(id));
        if (notice && "unacted" in notice)
          store.put({ id, copy: notice.copy, ranges: notice.ranges } satisfies Acted);
      });
      changed();
    },
    async unacted() {
      const open = await database.transact([NOTICES], "readonly", (tx) =>
        settled<Stored[]>(tx.objectStore(NOTICES).index(UNACTED).getAll()),
      );
      return open.map(({ unacted: _, ...notice }) => notice);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      channel?.close();
      channel = null;
      database.close();
    },
  };
}

/** No IndexedDB (server render, tests): nothing is stored, so every claim's words show unstored. */
function unavailableNotices(): HandBackNotices {
  return {
    claim: () => Promise.reject(new Error("IndexedDB is unavailable")),
    act: () => Promise.resolve(),
    unacted: () => Promise.resolve([]),
    subscribe: () => () => undefined,
    close: () => undefined,
  };
}
