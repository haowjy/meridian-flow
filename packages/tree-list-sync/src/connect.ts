/**
 * A client's connection to a tree list's room: what the browser's copy of the list does to stay
 * the server's. Owns the provider and the socket, sends in parts, and rebuilds the copy after a
 * whole refusal. It owns no storage and no tabs: the copy comes in through `ListCopy`.
 */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import { recordsOf, type TreeRecord } from "@meridian/project-tree";
import type * as Y from "yjs";
import { PART_RECORDS, splitSyncFrame } from "./parts.js";

/**
 * - `connecting`: no answer yet from the server this connection; the copy shows what it has
 * - `synced`: the server's state is in the copy and ours is in the server's
 * - `offline`: the connection dropped; the copy is still good and still takes records
 * - `rebuilding`: the server refused the copy whole; it is being thrown away and rebuilt
 * - `read-only`: synced, but the server keeps none of this copy's records: the account may read
 *   the list and not write it
 * - `denied`: the account has no access to this list; nothing will connect again
 *
 * A record the server keeps refusing after each rebuild is not appended again: `onRejected` has it.
 */
export type ListSyncState =
  | "connecting"
  | "synced"
  | "read-only"
  | "offline"
  | "rebuilding"
  | "denied";

/** The browser's copy of one list. */
export type ListCopy = {
  readonly doc: Y.Doc;
  /**
   * Starts a copy over: `doc` becomes an empty document under a new Yjs client id, and `carried`
   * (the records the old copy held) is stored with it, durably, before the old copy is retired.
   */
  replace(carried: readonly TreeRecord[]): Promise<void>;
  /** The records a rebuild carried that the rebuilt copy has not appended again. */
  carried(): readonly TreeRecord[];
  /** Forgets the carried records, once the copy holds all it needs of them. */
  settleCarried(): Promise<void>;
};

const DENIAL_CODES = new Set<number>([WS_CLOSE.AUTH_FAILED.code, WS_CLOSE.PERMISSION_DENIED.code]);
/** More rebuilds than this within the window and the records appended again are given up on. */
const MAX_REBUILDS = 3;
const REBUILD_WINDOW_MS = 60_000;

/** Sends what the server lacks from this copy in parts, never as one update. */
class PartsWebsocket extends HocuspocusProviderWebsocket {
  override send(message: unknown) {
    if (!(message instanceof Uint8Array)) return super.send(message);
    for (const part of splitSyncFrame(message, PART_RECORDS)) super.send(part);
  }
}

export function connectTreeList(options: {
  roomName: string;
  url: string;
  WebSocketPolyfill: unknown;
  copy: ListCopy;
  onState(state: ListSyncState): void;
  onRejected?(records: readonly TreeRecord[]): void;
}) {
  const { copy } = options;
  let socket: PartsWebsocket | null = null;
  let provider: HocuspocusProvider | null = null;
  let destroyed = false;
  let state: ListSyncState = "connecting";
  let readOnly = false;
  let rebuilds: number[] = [];

  const publish = (next: ListSyncState) => {
    if (state === next || destroyed) return;
    state = next;
    options.onState(next);
  };

  const isSynced = () => state === "synced" || state === "read-only";

  function stop() {
    provider?.destroy();
    socket?.destroy();
    provider = null;
    socket = null;
  }

  async function rebuild() {
    stop();
    publish("rebuilding");
    const now = Date.now();
    rebuilds = [...rebuilds.filter((at) => now - at < REBUILD_WINDOW_MS), now];
    await copy.replace(recordsOf(copy.doc).toArray());
    if (!destroyed) start();
  }

  /** Appends what the rebuilt copy lacks of the records the old one held; stored until it has. */
  async function appendAgain() {
    const carried = copy.carried();
    if (carried.length === 0) return;
    const held = new Set(
      recordsOf(copy.doc)
        .toArray()
        .map((record) => record.id),
    );
    // The rebuilt copy has every record the server admitted: only the rest goes again, as it was.
    const missing = carried.filter((record) => !held.has(record.id));
    if (rebuilds.length <= 1) {
      // The usual case is one update, one admission, whatever the number of records.
      if (missing.length > 0) copy.doc.transact(() => recordsOf(copy.doc).push([...missing]));
    } else {
      // The server refused those whole before, and does not say which record it refused: each
      // goes in a transaction of its own, so the honest ones are admitted around the one it
      // refuses. Past the limit the first is the one refused again and again: it is given up
      // on, and the rest go on.
      const giveUp = rebuilds.length > MAX_REBUILDS ? missing.slice(0, 1) : [];
      for (const record of missing.slice(giveUp.length))
        copy.doc.transact(() => recordsOf(copy.doc).push([record]));
      if (giveUp.length > 0) options.onRejected?.(giveUp);
    }
    await copy.settleCarried();
  }

  function start() {
    const doc = copy.doc;
    socket = new PartsWebsocket({
      url: options.url,
      WebSocketPolyfill: options.WebSocketPolyfill,
      autoConnect: false,
    });
    provider = new HocuspocusProvider({
      name: options.roomName,
      document: doc,
      websocketProvider: socket,
      onAuthenticated: ({ scope }) => {
        readOnly = scope === "readonly";
      },
      onSynced: () => {
        void appendAgain();
        publish(readOnly ? "read-only" : "synced");
      },
      onStatus: ({ status }) => {
        if (status !== "connected") publish(isSynced() ? "offline" : state);
      },
      // The server closes the socket itself with the refusal's code; any other close reconnects.
      onClose: ({ event }) => {
        if (event.code === WS_CLOSE.LIST_REBUILD.code) void rebuild();
        else if (DENIAL_CODES.has(event.code)) {
          publish("denied");
          queueMicrotask(stop);
        } else if (isSynced()) publish("offline");
      },
      onAuthenticationFailed: () => {
        publish("denied");
        queueMicrotask(stop);
      },
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
