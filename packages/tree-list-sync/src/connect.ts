/**
 * A client's connection to a tree list's room: what the browser's copy of the list does to stay
 * the server's. Owns the provider and the socket, sends in parts, and rebuilds the copy after a
 * whole refusal. It owns no storage and no tabs: the copy comes in through `ListCopy`.
 */
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { WS_CLOSE } from "@meridian/contracts/protocol";
import { recordsOf } from "@meridian/project-tree";
import type * as Y from "yjs";
import { PART_RECORDS, splitSyncFrame } from "./parts.js";

/**
 * - `connecting`: no answer yet from the server this connection; the copy shows what it has
 * - `synced`: the server's state is in the copy and ours is in the server's
 * - `offline`: the connection dropped; the copy is still good and still takes records
 * - `rebuilding`: the server refused the copy whole; it is being thrown away and rebuilt
 * - `denied`: the account has no access to this list; nothing will connect again

 * A record the server keeps refusing after each rebuild is not appended again: `onRejected` has it.
 */
export type ListSyncState = "connecting" | "synced" | "offline" | "rebuilding" | "denied";

/** The browser's copy of one list. `replace` throws the stored copy away and starts a new one. */
export type ListCopy = {
  readonly doc: Y.Doc;
  /** Clears the stored copy and makes `doc` an empty document under a new Yjs client id. */
  replace(): Promise<void>;
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
  onRejected?(records: readonly unknown[]): void;
}) {
  const { copy } = options;
  let socket: PartsWebsocket | null = null;
  let provider: HocuspocusProvider | null = null;
  let destroyed = false;
  let state: ListSyncState = "connecting";
  /** What the rejected copy held, to append to the rebuilt one once it has the server's state. */
  let carried: readonly unknown[] | null = null;
  let rebuilds: number[] = [];

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

  async function rebuild() {
    stop();
    publish("rebuilding");
    carried = [...recordsOf(copy.doc).toArray()];
    const now = Date.now();
    rebuilds = [...rebuilds.filter((at) => now - at < REBUILD_WINDOW_MS), now];
    await copy.replace();
    if (!destroyed) start();
  }

  function appendAgain() {
    if (carried === null) return;
    const lost = carried;
    carried = null;
    const held = new Set(
      recordsOf(copy.doc)
        .toArray()
        .map((record) => record.id),
    );
    // The rebuilt copy has every record the server admitted: only the rest goes again, as it was.
    const missing = lost.filter((record) => !held.has((record as { id: string }).id));
    // Each goes in a transaction of its own, so one the server refuses does not take the rest
    // with it. Past the limit the first is the one refused again and again: it is given up on,
    // and the rest go on.
    const giveUp = rebuilds.length > MAX_REBUILDS ? missing.slice(0, 1) : [];
    for (const record of missing.slice(giveUp.length))
      copy.doc.transact(() => recordsOf(copy.doc).push([record as never]));
    if (giveUp.length > 0) options.onRejected?.(giveUp);
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
      onSynced: () => {
        appendAgain();
        publish("synced");
      },
      onStatus: ({ status }) => {
        if (status !== "connected") publish(state === "synced" ? "offline" : state);
      },
      onClose: ({ event }) => {
        if (event.reason === WS_CLOSE.LIST_REBUILD.reason) void rebuild();
        else if (DENIAL_CODES.has(event.code)) {
          publish("denied");
          queueMicrotask(stop);
        } else if (state === "synced") publish("offline");
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
