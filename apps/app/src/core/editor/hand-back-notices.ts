/**
 * The account's hand-back notices: words a room could not deliver, kept with the notice that
 * offers them, apart from the copies they came from. One IndexedDB database per account, one
 * store. Two writes exist and neither can undo the other: `claim` adds a notice under a new id,
 * `act` sets `acted` on one. Each is one transaction, run one at a time across tabs, so two tabs
 * holding the same words get one notice between them.
 */
import type { AccountId } from "@meridian/contracts/protocol";
import { openIndexedDbDatabase, settled } from "../indexeddb-database";
import type { UnsentTypingCause } from "./document-session-registry";
import { addList, listOf, type RangeList, type Ranges, subtract } from "./item-ranges";

const NOTICES = "notices";
const BY_COPY = "copy";
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
  acted: boolean;
}>;

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
  /** Copy or Dismiss was pressed. Sets `acted`; nothing ever clears it. */
  act(id: string): Promise<void>;
  /** Every notice not acted on. */
  unacted(): Promise<HandBackNotice[]>;
  /**
   * Deletes the acted notices whose copy is gone: one only stops a later claim from that copy
   * offering its words again. Skipped where the browser can't list its databases.
   */
  forgetActed(): Promise<void>;
  /** Calls `listener` when another tab of the account claimed or acted on a notice. */
  subscribe(listener: () => void): () => void;
  close(): void;
}

export function createHandBackNotices(accountId: AccountId): HandBackNotices {
  const name = handBackNoticesName(accountId);
  if (typeof indexedDB === "undefined") return unavailableNotices();
  const database = openIndexedDbDatabase(name, (db) =>
    db.createObjectStore(NOTICES, { keyPath: "id" }).createIndex(BY_COPY, BY_COPY),
  );
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
        const earlier = await settled<HandBackNotice[]>(store.index(BY_COPY).getAll(copy));
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
          acted: false,
        };
        store.add(made);
        return made;
      });
      if (notice) changed();
      return notice;
    },
    async act(id) {
      await database.transact([NOTICES], "readwrite", async (tx) => {
        const store = tx.objectStore(NOTICES);
        const notice = await settled<HandBackNotice | undefined>(store.get(id));
        if (notice && !notice.acted) store.put({ ...notice, acted: true });
      });
      changed();
    },
    async unacted() {
      const all = await database.transact([NOTICES], "readonly", (tx) =>
        settled<HandBackNotice[]>(tx.objectStore(NOTICES).getAll()),
      );
      return all.filter((notice) => !notice.acted);
    },
    async forgetActed() {
      if (!indexedDB.databases) return;
      const existing = new Set((await indexedDB.databases()).map((each) => each.name));
      await database.transact([NOTICES], "readwrite", async (tx) => {
        const store = tx.objectStore(NOTICES);
        for (const notice of await settled<HandBackNotice[]>(store.getAll()))
          if (notice.acted && !existing.has(notice.copy)) store.delete(notice.id);
      });
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
    forgetActed: () => Promise.resolve(),
    subscribe: () => () => undefined,
    close: () => undefined,
  };
}
