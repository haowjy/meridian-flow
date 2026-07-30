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
 */

import type { Awareness } from "y-protocols/awareness";

/**
 * What a publisher holds: the channel it reads peers from, and its own field to
 * write. Not `suspend`/`resume` — whether this client is visible is the
 * session's answer, and a publisher that could resume presence would put a
 * hidden writer back on the wire.
 */
export type LocalPresenceFields = {
  /** Read peers from this; never write a local field to it directly. */
  readonly awareness: Awareness;
  /** Publish one field of this client's presence. Accepted while suspended. */
  setField: (field: string, value: unknown) => void;
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

  return {
    awareness,

    setField(field, value) {
      if (suspensions === 0) {
        awareness.setLocalStateField(field, value);
        return;
      }
      desired = { ...(desired ?? {}), [field]: value };
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
