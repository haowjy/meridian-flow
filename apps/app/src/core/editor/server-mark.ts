/**
 * The copy's mark of what the server is known to have: a Yjs state vector in the copy's `custom`
 * store. Per client, the server holds every item below the mark's clock, so what the copy holds
 * beyond it is all the server can still lack (`beyondMark`). A copy with no mark counts as one
 * that marks nothing.
 *
 * The mark only grows, per client, in one transaction, except when a handshake's state vector does
 * not cover it: the server no longer holds items it counts (a room restored from a checkpoint or
 * reseeded), and that handshake's vector replaces it. A mark too low offers words the server has;
 * one too high would lose words, so only the server's own vector and, once it has acknowledged
 * everything, what the socket's frames showed (`transport/server-has.ts`) are written; never the
 * document's, which can hold a local peer's items no frame carried.
 */
import * as Y from "yjs";

import { insertedBy, type Ranges } from "./item-ranges";

export const SERVER_MARK_KEY = "meridian:server-has";

type Clocks = Map<number, number>;

function covers(vector: Clocks, mark: Clocks): boolean {
  for (const [client, clock] of mark) if ((vector.get(client) ?? 0) < clock) return false;
  return true;
}

function grow(mark: Clocks, vector: Clocks): boolean {
  let grew = false;
  for (const [client, clock] of vector)
    if ((mark.get(client) ?? 0) < clock) {
      mark.set(client, clock);
      grew = true;
    }
  return grew;
}

export type ServerMark = {
  /**
   * `handshake`: the server's own SyncStep1, its whole state. Otherwise what the socket's frames
   * showed, once the server acknowledged everything.
   */
  note(vector: Uint8Array, handshake: boolean): void;
};

/** Writes what the server has shown into the copy `database()`, while it is open. */
export function createServerMark(database: () => IDBDatabase | null): ServerMark {
  // What this session already wrote: a vector it covers changes nothing and costs no transaction.
  const written: Clocks = new Map();
  return {
    note(vector, handshake) {
      const clocks = Y.decodeStateVector(vector);
      const copy = database();
      if (!copy || (!handshake && covers(written, clocks))) return;
      // A handshake can replace the mark: what was written before it may no longer stand.
      if (handshake) written.clear();
      grow(written, clocks);
      const transaction = copy.transaction("custom", "readwrite");
      transaction.onabort = () => reportError(transaction.error);
      const store = transaction.objectStore("custom");
      const read = store.get(SERVER_MARK_KEY);
      read.onsuccess = () => {
        const stored = read.result instanceof Uint8Array ? Y.decodeStateVector(read.result) : null;
        const kept = stored !== null && !(handshake && !covers(clocks, stored));
        const mark = kept ? stored : new Map<number, number>();
        if (!grow(mark, clocks) && kept) return;
        store.put(Y.encodeStateVector(mark), SERVER_MARK_KEY);
      };
    },
  };
}

/** The items `copy` (an update) holds beyond `mark`. */
export function beyondMark(copy: Uint8Array, mark: Uint8Array): Ranges {
  return insertedBy(Y.diffUpdate(copy, mark));
}
