// Observation frontiers on Loro (design §5): what a result showed is the frontiers of every doc of
// the room copy it rendered from, and a write plans on a view of the room at them.
import {
  type DocKey,
  type DocVersion,
  decodeEnvelope,
  docVersion,
  encodeEnvelope,
  plainVersion,
  type RoomDocs,
  STRUCTURE_KEY,
  updateEnd,
  withVector,
} from "@meridian/document-model";
import {
  decodeFrontiers,
  encodeFrontiers,
  type Frontiers,
  type LoroDoc,
  type PeerID,
} from "loro-crdt";

export type FrontierMap = ReadonlyMap<DocKey, Frontiers>;

/** `observation_frontiers.snapshot` on Loro: an envelope of each shown doc's encoded frontiers. */
export function encodeFrontierMap(frontiers: FrontierMap): Uint8Array {
  return encodeEnvelope(new Map([...frontiers].map(([key, at]) => [key, encodeFrontiers(at)])));
}

/** Null for bytes that are not a Loro frontier map (a frontier an older build recorded). */
export function decodeFrontierMap(bytes: Uint8Array): Map<DocKey, Frontiers> | null {
  try {
    const map = new Map<DocKey, Frontiers>();
    for (const [key, at] of decodeEnvelope(bytes)) map.set(key, decodeFrontiers(at));
    return map.has(STRUCTURE_KEY) ? map : null;
  } catch {
    return null;
  }
}

/** The doc a reader of `docs` reads `key` from: its own, else Live's for a draft. */
function shownDoc(docs: RoomDocs, key: DocKey): LoroDoc | undefined {
  return key === STRUCTURE_KEY ? docs.structure : docs.textOf(key);
}

type Vector = Map<PeerID, number>;

const vectorOf = (doc: LoroDoc, at: Frontiers): Vector =>
  new Map(plainVersion(doc.frontiersToVV(at)));

function merged(into: Vector, from: DocVersion): Vector {
  for (const [peer, end] of from) if ((into.get(peer) ?? 0) < end) into.set(peer, end);
  return into;
}

/**
 * Whether `at` is a version `doc` can be checked out at: every id in it is in the doc, and none
 * lies below a shallow doc's cutoff (design §5's first check, made explicitly: a diff from below
 * the cutoff sometimes answers instead of throwing, loro#1294).
 */
function usableIn(doc: LoroDoc, at: Frontiers): boolean {
  const have = docVersion(doc);
  if (at.some((id) => (have.get(id.peer) ?? 0) <= id.counter)) return false;
  if (!doc.isShallow()) return true;
  const since = plainVersion(doc.shallowSinceVV());
  const roots = doc.shallowSinceFrontiers();
  return !at.some(
    (id) =>
      id.counter < (since.get(id.peer) ?? 0) &&
      !roots.some((root) => root.peer === id.peer && root.counter === id.counter),
  );
}

/**
 * The frontiers a write plans on: what the model read (`recorded`), plus the reply's own batches
 * since (`own`, the exact envelopes its writes committed), per doc. Null when some recorded doc is
 * no longer in `docs` or a frontier lies below its cutoff: the write then plans on the transcript.
 * A doc the model never saw (created since the read) is left out, so the view lacks it.
 */
export function planningFrontiers(
  docs: RoomDocs,
  recorded: FrontierMap,
  own: readonly Uint8Array[],
): Map<DocKey, Frontiers> | null {
  const vectors = new Map<DocKey, Vector>();
  for (const [key, at] of recorded) {
    const doc = shownDoc(docs, key);
    if (!doc || !usableIn(doc, at)) return null;
    vectors.set(key, vectorOf(doc, at));
  }
  for (const batch of own)
    for (const [key, bytes] of decodeEnvelope(batch)) {
      vectors.set(key, merged(vectors.get(key) ?? new Map(), updateEnd(bytes)));
    }
  const out = new Map<DocKey, Frontiers>();
  for (const [key, vector] of vectors) {
    const doc = shownDoc(docs, key);
    if (!doc) return null;
    out.set(
      key,
      withVector(vector, (vv) => doc.vvToFrontiers(vv)),
    );
  }
  return out;
}

/** The doc keys whose frontiers differ between a recorded read and `docs` now. */
export function changedSince(docs: RoomDocs, recorded: FrontierMap): Set<DocKey> {
  const now = docs.frontiers();
  const changed = new Set<DocKey>();
  for (const [key, at] of now) {
    const then = recorded.get(key);
    if (!then || !sameFrontiers(then, at)) changed.add(key);
  }
  for (const key of recorded.keys()) if (!now.has(key)) changed.add(key);
  return changed;
}

function sameFrontiers(a: Frontiers, b: Frontiers): boolean {
  if (a.length !== b.length) return false;
  return a.every((id) => b.some((other) => other.peer === id.peer && other.counter === id.counter));
}

/**
 * The commit messages of the changes in `doc` between `from` (a recorded frontier, or none for a
 * doc the read never saw) and now, one per change: `turn:<id>`, `press:<id>`, or undefined for
 * the writer's own typing (design §5).
 */
export function messagesSince(doc: LoroDoc, from: Frontiers | undefined): (string | undefined)[] {
  const messages: (string | undefined)[] = [];
  for (const span of doc.findIdSpansBetween(from ?? [], doc.frontiers()).forward) {
    let counter = span.counter;
    while (counter < span.counter + span.length) {
      const change = doc.getChangeAt({ peer: span.peer, counter });
      messages.push(change.message || undefined);
      counter = change.counter + change.length;
    }
  }
  return messages;
}
