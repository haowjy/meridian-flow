/**
 * One client's own presence: the fields it publishes (its caret, which uploads it is sending,
 * `upload-presence.ts`), and whether they are on the wire at all. The wire is the room's Loro
 * ephemeral store, one entry per copy keyed by its peer id; the transport relays its local
 * updates and applies peers'.
 *
 * One owner holds both questions. While presence is live the store's entry IS the desired state
 * and a field write goes straight to it. Suspension (inline review hides the document behind it,
 * a schema fence hides a client that may no longer write, a detached transport, a hidden page)
 * deletes the entry and holds the desired map: writes land in it, and resume publishes the map
 * as it now stands rather than as it was when the suspension began.
 */
import { EphemeralStore, type Value } from "loro-crdt";

/** One copy's fields, as plain JSON the ephemeral store carries. */
export type PeerState = { [field: string]: Value };

/**
 * Peers as a publisher may see them: who else is here, what they say, and when that changes. It
 * cannot write; `setField` does that.
 */
export type PeerAwareness = {
  /** This copy's own key. */
  readonly clientID: string;
  getStates(): Map<string, PeerState>;
  /** Called when a peer's state changes (an import or an expiry), never for this copy's own. */
  on(event: "change", handler: () => void): void;
  off(event: "change", handler: () => void): void;
};

/**
 * What a publisher holds: the channel it reads peers from, and its own field to write. Not
 * `suspend`/`resume`: whether this client is visible is the session's answer.
 */
export type LocalPresenceFields = {
  readonly peers: PeerAwareness;
  /** Publish one field of this client's presence. Accepted while suspended. */
  setField: (field: string, value: Value) => void;
  /** This client's fields as it means them, on the wire or not. */
  localState: () => PeerState | null;
  /**
   * Which editor wrote the caret now on the wire. One slot for the session, so views of one
   * session can tell whose caret it is (see `gateCaretPresence`).
   */
  readonly caretPublisher: { current: object | null };
};

/** The whole of one client's presence, as its owner holds it. */
export type LocalPresence = LocalPresenceFields & {
  /** The store the transport carries. */
  readonly store: EphemeralStore;
  suspend: () => void;
  resume: () => void;
  release: () => void;
};

/** A peer's entry expires this long after its last update; carets refresh it while shown. */
const PRESENCE_TIMEOUT_MS = 30_000;

export function createLocalPresence(self: string): LocalPresence {
  const store = new EphemeralStore(PRESENCE_TIMEOUT_MS);
  let suspensions = 0;
  let desired: PeerState | null = null;
  const handlers = new Set<() => void>();
  // Peers' changes only: a publisher reads peers, and its own writes would only echo.
  store.subscribe((event) => {
    if (event.by === "local") return;
    for (const handler of [...handlers]) handler();
  });
  // Peers drop an entry PRESENCE_TIMEOUT_MS after its last write, so a still caret is re-sent.
  const refresh = setInterval(() => {
    if (suspensions === 0 && desired) store.set(self, desired);
  }, PRESENCE_TIMEOUT_MS / 3);

  const setField = (field: string, value: Value): void => {
    desired = { ...(desired ?? {}), [field]: value };
    if (suspensions === 0) store.set(self, desired);
  };

  return {
    store,
    peers: {
      clientID: self,
      getStates: () => new Map(Object.entries(store.getAllStates()) as [string, PeerState][]),
      on: (_event, handler) => handlers.add(handler),
      off: (_event, handler) => handlers.delete(handler),
    },
    setField,
    localState: () => desired,
    caretPublisher: { current: null },
    suspend() {
      if (suspensions++ > 0) return;
      store.delete(self);
    },
    resume() {
      if (suspensions === 0) return;
      suspensions -= 1;
      if (suspensions > 0) return;
      if (desired) store.set(self, desired);
    },
    release() {
      clearInterval(refresh);
      suspensions = 0;
      desired = null;
      handlers.clear();
      store.destroy();
    },
  };
}

/**
 * One session can be edited from two views at once (main and the side both showing it). Both
 * write the same `cursor` field, so the caret, and only the caret, is arbitrated: this view's
 * `cursor` writes pass while `publishing()` is true and are dropped otherwise. A view that goes to
 * the back calls `retire()` once, which clears the caret only if this view is still the session's
 * current caret publisher, so a back view never clears the front one's.
 */
export function gateCaretPresence(
  presence: LocalPresenceFields,
  publishing: () => boolean,
): { presence: LocalPresenceFields; retire: () => void } {
  const publisher = presence.caretPublisher;
  const self = {};
  return {
    presence: {
      peers: presence.peers,
      localState: presence.localState,
      caretPublisher: publisher,
      setField(field, value) {
        if (field !== "cursor") return presence.setField(field, value);
        if (!publishing()) return;
        publisher.current = self;
        presence.setField(field, value);
      },
    },
    retire() {
      if (publisher.current !== self) return;
      publisher.current = null;
      presence.setField("cursor", null);
    },
  };
}
