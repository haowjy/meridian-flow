/**
 * Observation frontiers: what document state a model was shown. A frontier holds the frontiers of
 * each doc a result showed, in the room copy it was rendered from, and a write plans on a view of
 * the room at them (design §5). The host names rooms.
 */
import {
  type CommitAuthor,
  type DocKey,
  type DocVersion,
  decodeEnvelope,
  docVersion,
  encodeEnvelope,
  plainVersion,
  type RoomDocs,
  readCommitMessage,
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

/** One block a result showed the model in full, in whichever room it read; later showings last. */
export interface ShownBlock {
  hash: string;
  body: string;
}

export interface ObservationFrontier {
  /** The host's label for the room the result read (`loroRoomName`); carried, never read. */
  room: string;
  /**
   * What the result showed in the room: for a document's room, `encodeFrontierMap` of the docs it
   * showed at the copy it was rendered from; the host's own bytes for a room it names itself.
   */
  snapshot: Uint8Array;
}

/**
 * A host's lookup of the model's latest read of a document: the latest frontier recorded in any of
 * the document's rooms (Live, or any draft's fork), tagged with that room. A chat can switch
 * between Live and Draft, so its latest read may be of the other room; the core checks whether
 * the room it writes in can check that read out (design §5). Never throws: an unavailable
 * frontier is `null`, the empty one.
 */
export type FrontierLookup = (documentId: string) => Promise<ObservationFrontier | null>;

/**
 * A call's lookups. `recording` chains what a result records (a sibling call's
 * result counts as seen); `planning` is the model's view as of the request that
 * produced the call (C4), which a write plans on; `reply` is what the reply has
 * itself done since that request, which the view replays after the frontier.
 */
export interface FrontierLookups {
  recording: FrontierLookup;
  /** Required for a model reply's write; a read plans nothing. */
  planning?: FrontierLookup;
  /**
   * The blocks the planning frontier's results showed in full of the document, in every room it
   * read, oldest first: what a write plans on when its latest read can't be checked out in the room
   * it writes in (history compacted below it, or a draft's read of text Live doesn't hold).
   */
  planningShown?: (documentId: string) => Promise<readonly ShownBlock[]>;
  reply?: ReplyMutations;
}

/**
 * One provider reply's own accepted mutations per document, in execution order: its writes,
 * undo, redo and revert, each as the exact bytes its command committed; and the documents it created (a create into
 * a missing or empty document), which began empty for the model. The reply owns it from its
 * first tool call to its terminal boundary, which clears it; nothing caps or evicts it before.
 */
export interface ReplyMutations {
  updates(docId: string): readonly Uint8Array[];
  append(docId: string, updates: readonly Uint8Array[]): void;
  created(docId: string): boolean;
  noteCreated(docId: string): void;
  /** What a rolled-back command leaves behind: call the returned function to put this state back. */
  checkpoint(): () => void;
  clear(): void;
}

export function createReplyMutations(): ReplyMutations {
  const docs = new Map<string, Uint8Array[]>();
  const created = new Set<string>();
  return {
    updates: (docId) => docs.get(docId) ?? [],
    append(docId, updates) {
      if (updates.length) docs.set(docId, [...(docs.get(docId) ?? []), ...updates]);
    },
    created: (docId) => created.has(docId),
    noteCreated: (docId) => created.add(docId),
    checkpoint() {
      const kept = new Map(docs);
      const keptCreated = new Set(created);
      return () => {
        docs.clear();
        for (const [docId, updates] of kept) docs.set(docId, updates);
        created.clear();
        for (const docId of keptCreated) created.add(docId);
      };
    },
    clear() {
      docs.clear();
      created.clear();
    },
  };
}

export type FrontierMap = ReadonlyMap<DocKey, Frontiers>;

/** `observation_frontiers.snapshot` on Loro: an envelope of each shown doc's encoded frontiers. */
export function encodeFrontierMap(frontiers: FrontierMap): Uint8Array {
  return encodeEnvelope(new Map([...frontiers].map(([key, at]) => [key, encodeFrontiers(at)])));
}

/** Null for bytes that are not a Loro frontier map. */
function decodeFrontierMap(bytes: Uint8Array): Map<DocKey, Frontiers> | null {
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

/**
 * The chat's latest read of `documentId`, in whichever of its rooms it was (design §5): null when
 * it never read the document. A write plans on it when its room can check it out
 * (`planningFrontiers`), and on the transcript when not: a later read is never passed over for an
 * earlier one, whose text the model no longer works from.
 */
export async function latestRead(
  lookup: FrontierLookup,
  documentId: string,
): Promise<FrontierMap | null> {
  const frontier = await lookup(documentId);
  return frontier ? decodeFrontierMap(frontier.snapshot) : null;
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
 * Who wrote each change in `doc` between `from` (a recorded frontier, or none for a doc the read
 * never saw) and now, by its commit message: a chat's turn, a press, or undefined for the writer
 * (design §5).
 */
export function authorsSince(
  doc: LoroDoc,
  from: Frontiers | undefined,
): (CommitAuthor | undefined)[] {
  const authors: (CommitAuthor | undefined)[] = [];
  for (const span of doc.findIdSpansBetween(from ?? [], doc.frontiers()).forward) {
    let counter = span.counter;
    while (counter < span.counter + span.length) {
      const change = doc.getChangeAt({ peer: span.peer, counter });
      authors.push(readCommitMessage(change.message).by);
      counter = change.counter + change.length;
    }
  }
  return authors;
}
