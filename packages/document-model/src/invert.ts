import type { Frontiers, LoroDoc } from "loro-crdt";
import { freshPeerId } from "./peer.js";
import type { RoomDocs } from "./room-docs.js";
import {
  configureDoc,
  type DocKey,
  overrideMap,
  STRUCTURE_KEY,
  STRUCTURE_MAPS,
  sameValue,
} from "./shape.js";
import type { DocChange } from "./write.js";

/**
 * The one Undo rule (design §2, §6): the change `before → after` of one doc is inverted at its own
 * frontier, so it takes back that change and nothing a peer wrote since.
 *
 * A text doc is forked at `after`, the diff back to `before` applied there under a fresh peer (the
 * fork's counters for the copy's own peer would collide with ops the copy wrote since), and the
 * result imported: its ops are concurrent with every later edit and merge like a peer's. The
 * structure's value maps are set back key by key, under the copy's own peer, except a key written
 * since the change, which keeps its newer value. A draft inverts only its overrides.
 *
 * Returns the inverse as a change of its own, to publish and for Redo to invert; null when it
 * changes nothing (the change was already taken back).
 */
export function invertChange(docs: RoomDocs, change: DocChange): DocChange | null {
  const before = change.doc.frontiers();
  const from = change.doc.oplogVersion();
  if (change.key === STRUCTURE_KEY) invertMaps(docs, change);
  else {
    const at = change.doc.forkAt(change.after);
    try {
      at.setPeerId(freshPeerId());
      configureDoc(at, docs.shape);
      at.applyDiff(at.diff(change.after, change.before, false));
      at.commit({ origin: "undo" });
      change.doc.import(at.export({ mode: "update", from }));
    } finally {
      at.free();
    }
  }
  if (change.doc.oplogVersion().compare(from) === 0) return null;
  return { key: change.key, doc: change.doc, before, after: change.doc.frontiers() };
}

function invertMaps(docs: RoomDocs, change: DocChange) {
  const doc = change.doc;
  const prior = doc.forkAt(change.before);
  const written = doc.forkAt(change.after);
  try {
    for (const base of STRUCTURE_MAPS) {
      const name = docs.draft ? overrideMap(base) : base;
      const old = prior.getMap(name);
      const last = written.getMap(name);
      const current = doc.getMap(name);
      for (const key of new Set([...old.keys(), ...last.keys()])) {
        const was = old.get(key);
        const wrote = last.get(key);
        if (sameValue(was, wrote) || !sameValue(current.get(key), wrote)) continue;
        if (was === undefined) current.delete(key);
        else current.set(key, was);
      }
    }
    doc.commit({ origin: "undo" });
  } finally {
    prior.free();
    written.free();
  }
}

/** The keys of the docs a set of changes touched, structure first. */
export function changedKeys(changes: readonly { key: DocKey }[]): DocKey[] {
  const keys = [...new Set(changes.map((change) => change.key))];
  return keys.sort((a, b) => (a === STRUCTURE_KEY ? -1 : b === STRUCTURE_KEY ? 1 : 0));
}

/** A doc's update from `before` on: the ops one change wrote. */
export function changeUpdate(doc: LoroDoc, before: Frontiers): Uint8Array {
  return before.length === 0
    ? doc.export({ mode: "update" })
    : doc.export({ mode: "update", from: doc.frontiersToVV(before) });
}
