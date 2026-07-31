/**
 * One client's own presence: the fields it publishes, and whether they are on
 * the wire at all.
 *
 * Awareness carries two kinds of local fact — the caret y-prosemirror writes,
 * and fields the app publishes itself (which slots this browser is filling,
 * `images/image-upload-presence.ts`) — while something else entirely decides
 * whether this client should be visible right now: inline review hides the
 * writer's presence in the document behind it, and a schema fence hides a
 * client that may no longer write.
 *
 * Those two questions used to have two owners, and the seam between them lost
 * writes. Yjs' `setLocalStateField` is a silent no-op while local state is
 * null, which is exactly what "suspended" looks like, so a publisher that wrote
 * during suspension recorded a change that never happened — and suspension
 * restored the snapshot it took, resurrecting the value the publisher had
 * already corrected.
 *
 * So one owner holds both: while presence is live, Awareness IS the desired
 * state and a field write goes straight to it. Suspension is the only moment
 * the two can differ, and for exactly that span this holds the desired map:
 * writes land in it, the transport publishes null, and resume publishes the map
 * as it now stands rather than as it was when the writer opened the review.
 *
 * Upstream collaboration plugins know nothing about any of that: TipTap's
 * CollaborationCaret and y-prosemirror's cursor plugin write `user` and
 * `cursor` onto whatever Awareness their provider hands them. So they are
 * handed `caretProvider` instead of the real one. It wears Awareness' shape and
 * routes every local write and read back through this owner, which is why a
 * caret the destroyed editor cleared behind a review stays cleared when the
 * review ends.
 */

import type { Awareness } from "y-protocols/awareness";

/**
 * Peers as a publisher may see them: who else is here, what they say, and when
 * that changes.
 *
 * Deliberately narrower than `Awareness`. A local field write belongs to
 * `setField`, and handing out this type is what keeps that a rule of the port
 * rather than a comment the next publisher has to read.
 */
export type PeerAwareness = Readonly<Pick<Awareness, "clientID" | "getStates" | "on" | "off">>;

/**
 * The Awareness shape upstream collaboration plugins reach through
 * `provider.awareness`: CollaborationCaret's `user` write and peer list, and
 * y-prosemirror's `cursor` write, its read of the local cursor it compares
 * against, and its clear on blur and on view destroy. Every one of those is
 * this client's own presence, so all of them route through the owner.
 *
 * No `setLocalState`: nothing upstream calls it, and a whole-state write would
 * let one publisher erase a field it does not own.
 */
export type CaretAwareness = PeerAwareness &
  Readonly<Pick<Awareness, "states" | "getLocalState" | "setLocalStateField">>;

/** What `CollaborationCaret.configure({ provider })` takes. */
export type CaretProvider = { readonly awareness: CaretAwareness };

/**
 * What a publisher holds: the channel it reads peers from, and its own field to
 * write. Not `suspend`/`resume` — whether this client is visible is the
 * session's answer, and a publisher that could resume presence would put a
 * hidden writer back on the wire.
 */
export type LocalPresenceFields = {
  /** Read peers from here. It cannot write a local field; `setField` does that. */
  readonly peers: PeerAwareness;
  /** Publish one field of this client's presence. Accepted while suspended. */
  setField: (field: string, value: unknown) => void;
  /** The same single write path, in the shape upstream plugins demand. */
  readonly caretProvider: CaretProvider;
};

/** The whole of one client's presence, as its owner holds it. */
export type LocalPresence = LocalPresenceFields & {
  /** Take this client off the wire, keeping every later field write. */
  suspend: () => void;
  /** Put the CURRENT desired fields back on the wire. Nests with `suspend`. */
  resume: () => void;
  /** Presence is over: forget the suspension and whatever it was holding. */
  release: () => void;
};

export function createLocalPresence(awareness: Awareness): LocalPresence {
  let suspensions = 0;
  /** The desired fields while suspended, and null whenever Awareness holds them. */
  let desired: Record<string, unknown> | null = null;

  /**
   * This client's fields as it means them, on the wire or not. y-prosemirror
   * compares its own caret against this before writing and before clearing, so
   * a suspension that answered null would leave it believing it had never
   * published a caret at all.
   */
  const getLocalState = (): Record<string, unknown> | null =>
    suspensions === 0 ? awareness.getLocalState() : desired;

  const setField = (field: string, value: unknown): void => {
    if (suspensions === 0) {
      awareness.setLocalStateField(field, value);
      return;
    }
    desired = { ...(desired ?? {}), [field]: value };
  };

  return {
    peers: awareness,
    setField,

    caretProvider: {
      awareness: {
        clientID: awareness.clientID,
        // A getter rather than the Map itself: `states` is Awareness' own
        // property, and a copy taken here would stop tracking who is present.
        get states() {
          return awareness.states;
        },
        getStates: () => awareness.getStates(),
        getLocalState,
        setLocalStateField: setField,
        on: (name, handler) => awareness.on(name, handler),
        off: (name, handler) => awareness.off(name, handler),
      },
    },

    suspend() {
      // Only the outermost suspension takes the snapshot: a nested one would
      // snapshot the null it is already looking at and drop the desired map.
      if (suspensions++ > 0) return;
      desired = awareness.getLocalState() as Record<string, unknown> | null;
      awareness.setLocalState(null);
    },

    resume() {
      if (suspensions === 0) return;
      suspensions -= 1;
      if (suspensions > 0) return;
      const fields = desired;
      desired = null;
      // Null means this client had nothing to say before it was suspended and
      // said nothing during it, which is still the honest state.
      if (fields) awareness.setLocalState(fields);
    },

    release() {
      suspensions = 0;
      desired = null;
    },
  };
}
