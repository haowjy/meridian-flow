/**
 * A client's connection to a tree list's room: what the browser's copy of the list does to stay
 * the server's. Owns the provider and the socket, sends in parts, and loads a fresh copy when the
 * server closes the connection for the copy's own fault or names another list. It owns no storage
 * and no tabs: the copy comes in through `ListCopy`.
 */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { listChangedId, WS_CLOSE } from "@meridian/contracts/protocol";
import { clientMayWrite, recordsOf, type TreeRecord } from "@meridian/project-tree";
import type * as Y from "yjs";
import { PART_RECORDS, splitSyncFrame } from "./parts.js";

/**
 * - `connecting`: no answer yet from the server this connection; the copy shows what it has
 * - `synced`: the server's state is in the copy and ours is in the server's
 * - `offline`: the connection dropped; the copy is still good and still takes records
 * - `broken`: the server closed the connection for what the copy holds, twice running (the
 *   fresh copy broke as well); nothing connects again
 * - `unauthenticated`: the sign-in did not hold (expired session, a refresh that failed); nothing
 *   connects again until the writer signs in. It says nothing about the account's access.
 * - `denied`: the account has no access to this list; nothing will connect again
 */
export type ListSyncState =
  | "connecting"
  | "synced"
  | "offline"
  | "broken"
  | "unauthenticated"
  | "denied";

/** The browser's copy of one list. */
export type ListCopy = {
  readonly doc: Y.Doc;
  /** The list the copy was made of, once the server has said which; null before. */
  listId(): string | null;
  /** Remembers which list the copy is of. */
  setListId(id: string): Promise<void>;
  /**
   * Starts a copy over: `doc` becomes an empty document under a new Yjs client id, of the list
   * `listId` (null: not known yet). `carried` (the records the old copy held) is stored with it,
   * durably, before the old copy is retired.
   */
  replace(carried: readonly TreeRecord[], listId: string | null): Promise<void>;
  /** The records a replacement carried that the new copy has not appended again. */
  carried(): readonly TreeRecord[];
  /** Forgets the carried records, once the copy holds all it needs of them. */
  settleCarried(): Promise<void>;
};

/** Sends what the server lacks from this copy in parts, never as one update. */
class PartsWebsocket extends HocuspocusProviderWebsocket {
  override send(message: unknown) {
    if (!(message instanceof Uint8Array)) return super.send(message);
    for (const part of splitSyncFrame(message, PART_RECORDS)) super.send(part);
  }
}

export function connectTreeList(options: {
  roomName: string;
  /** The socket's address; `listId` is the list the copy is of, which the server checks. */
  url(listId: string | null): string;
  WebSocketPolyfill: unknown;
  copy: ListCopy;
  onState(state: ListSyncState): void;
  /** Records a recovered copy could not append again: what a client of this build never writes. */
  onDropped?(records: readonly TreeRecord[]): void;
}) {
  const { copy } = options;
  let socket: PartsWebsocket | null = null;
  let provider: HocuspocusProvider | null = null;
  let destroyed = false;
  let state: ListSyncState = "connecting";
  /** A fresh copy took the broken one's records, and the server has not yet taken them. */
  let recovering = false;
  let appended = false;

  const publish = (next: ListSyncState) => {
    if (state === next || destroyed) return;
    state = next;
    options.onState(next);
  };

  function stop() {
    provider?.destroy();
    socket?.destroy();
    provider = null;
    socket = null;
  }

  /** The server closed the connection for the copy's own fault: it is not sent again. */
  async function recover() {
    stop();
    if (recovering) return publish("broken");
    recovering = true;
    publish("connecting");
    await copy.replace(recordsOf(copy.doc).toArray(), copy.listId());
    if (!destroyed) start();
  }

  /** The stored copy is of another list: its records name nodes that are gone, so none are carried. */
  async function loadFromNothing(listId: string) {
    stop();
    publish("connecting");
    await copy.replace([], listId);
    if (!destroyed) start();
  }

  /**
   * Appends what the fresh copy lacks of the records the broken one held, once: a record a client
   * of this build never writes is dropped, and the rest go in one update. Stored until it has.
   */
  async function appendAgain() {
    const carried = copy.carried();
    if (carried.length === 0) return;
    const held = new Set(
      recordsOf(copy.doc)
        .toArray()
        .map((record) => record.id),
    );
    const missing = carried.filter((record) => !held.has(record.id));
    const send = missing.filter(clientMayWrite);
    const dropped = missing.filter((record) => !send.includes(record));
    if (send.length > 0) {
      appended = true;
      copy.doc.transact(() => recordsOf(copy.doc).push(send));
    } else recovering = false;
    if (dropped.length > 0) options.onDropped?.(dropped);
    await copy.settleCarried();
  }

  function end(next: "unauthenticated" | "denied") {
    publish(next);
    queueMicrotask(stop);
  }

  function start() {
    const doc = copy.doc;
    socket = new PartsWebsocket({
      url: options.url(copy.listId()),
      WebSocketPolyfill: options.WebSocketPolyfill,
      autoConnect: false,
    });
    provider = new HocuspocusProvider({
      name: options.roomName,
      document: doc,
      websocketProvider: socket,
      onSynced: () => {
        void appendAgain();
        publish("synced");
      },
      // A copy that has not met the server's list learns its id here, for the next connection.
      onStateless: ({ payload }) => {
        const { list } = JSON.parse(payload) as { list?: unknown };
        if (typeof list === "string" && copy.listId() === null) void copy.setListId(list);
      },
      // The server has the records the fresh copy appended: the next fault is a new one.
      onUnsyncedChanges: ({ number }) => {
        if (number === 0 && appended) recovering = appended = false;
      },
      onStatus: ({ status }) => {
        if (status !== "connected") publish(state === "synced" ? "offline" : state);
      },
      // The server closes the socket itself with the reason's code; any other close reconnects.
      onClose: ({ event }) => {
        const changed = listChangedId(event);
        if (event.code === WS_CLOSE.COPY_BROKEN.code) void recover();
        else if (changed !== undefined) void loadFromNothing(changed);
        else if (event.code === WS_CLOSE.AUTH_FAILED.code) end("unauthenticated");
        else if (event.code === WS_CLOSE.PERMISSION_DENIED.code) end("denied");
        else if (state === "synced") publish("offline");
      },
      onAuthenticationFailed: ({ reason }) =>
        end(reason === WS_CLOSE.AUTH_FAILED.reason ? "unauthenticated" : "denied"),
    });
    provider.attach();
    void socket.connect();
  }

  start();

  return {
    destroy() {
      destroyed = true;
      stop();
    },
  };
}
