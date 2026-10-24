/**
 * Restoration provenance: Discard base copies, Undo restoration links and Undo deletion witnesses.
 *
 * Yjs never undeletes. `redoItem` creates a new item at a new id with a copy of the old content and sets
 * `original.redone` to it, for every kind of item (text, element, descendant, format, map attribute). Only
 * the doc that ran the Undo holds those pointers, so `recordRestorations` copies them into a writer-writable
 * root of the draft, outside the UndoManagers' prose scope. The root syncs and persists with the
 * draft, so the server and every reload read the same links, and the classifier follows them through chains
 * (a second Discard and Undo). Nothing is inferred afterwards.
 *
 * Records are trusted writer provenance, not proof reconstructed from tombstones: either side of an
 * intermediate link may have been collected. We validate ID ranges, never retained content kinds.
 */
import * as Y from "yjs";
import type { ItemRange } from "./id-index.js";

/** Three-number ranges record base write-backs, four-number tuples Undo deletions, five-number tuples Undo links. */
export const RESTORED_ROOT = "__meridian_review_restored_v1";

type UndoDeletion = readonly [client: number, clock: number, length: number, undo: 0];

/** `[client, clock, length, toClient, toClock]`: ids `client:clock..+length` restore `toClient:toClock..`. */
export type RestorationLink = readonly [
  client: number,
  clock: number,
  length: number,
  toClient: number,
  toClock: number,
];

/** Persist server-computed inverse aliases in the same room evidence browser Undo uses. */
export function appendRestorationLinks(
  doc: Y.Doc,
  aliases: readonly {
    source: { client: number; clock: number };
    target: { client: number; clock: number };
    len: number;
  }[],
): void {
  if (!aliases.length) return;
  doc
    .getArray<RestorationLink>(RESTORED_ROOT)
    .push(
      aliases.map(
        ({ source, target, len }) =>
          [target.client, target.clock, len, source.client, source.clock] as const,
      ),
    );
}

/**
 * Record inserted base IDs minus exact copies, before appending provenance consumes another clock.
 * The caller owns the transaction; its UndoManager scopes the prose fragment, not this root.
 */
export function recordWriteBack(
  doc: Y.Doc,
  startClock: number,
  copies: readonly RestorationLink[] = [],
): void {
  const end = Y.getState(doc.store, doc.clientID);
  const records: Array<ItemRange | RestorationLink> = [...copies];
  let clock = startClock;
  for (const link of [...copies].sort((a, b) => a[1] - b[1])) {
    if (clock < link[1]) records.push([doc.clientID, clock, link[1] - clock]);
    clock = link[1] + link[2];
  }
  if (clock < end) records.push([doc.clientID, clock, end - clock]);
  if (records.length) doc.getArray<ItemRange | RestorationLink>(RESTORED_ROOT).push(records);
}

const recordedHistories = new WeakSet<Y.UndoManager>();

/** Installs once per manager, recording restorations as each undo or redo pops for its life. */
export function recordRestorations(history: Y.UndoManager): void {
  if (recordedHistories.has(history)) return;
  recordedHistories.add(history);
  // Keep the outer transaction open through stack-item-popped. Yjs resets its direction flag before
  // returning; restore it until transaction cleanup so afterTransaction fills the opposite stack.
  for (const method of ["undo", "redo"] as const) {
    const pop = history[method].bind(history);
    const flag = method === "undo" ? "undoing" : "redoing";
    history[method] = () => {
      let result: ReturnType<typeof pop> = null;
      try {
        history.doc.transact(() => {
          result = pop();
          history[flag] = true;
        }, history);
      } finally {
        history[flag] = false;
      }
      return result;
    };
  }
  history.on("stack-item-popped", ({ stackItem }) => {
    const { doc } = history;
    const links: RestorationLink[] = [];
    for (const [client, ranges] of stackItem.deletions.clients) {
      for (const { clock, len } of ranges) {
        for (let k = clock; k < clock + len && Y.getState(doc.store, client) > k; ) {
          const struct = Y.getItem(doc.store, Y.createID(client, k));
          const end = Math.min(clock + len, struct.id.clock + struct.length);
          if (struct instanceof Y.Item && struct.redone)
            pushLink(links, [
              struct.redone.client,
              struct.redone.clock + (k - struct.id.clock),
              end - k,
              client,
              k,
            ]);
          k = end;
        }
      }
    }
    // Removing Discard's temporary base copies is not a second removal of the review base.
    // Keep the deletion witness separate from origin: Redo must still restore those copies as base.
    const deletions: UndoDeletion[] = [];
    for (const [client, ranges] of (doc._transaction as Y.Transaction).deleteSet.clients)
      for (const { clock, len } of ranges) deletions.push([client, clock, len, 0]);
    if (links.length || deletions.length)
      doc.getArray<RestorationLink | UndoDeletion>(RESTORED_ROOT).push([...links, ...deletions]);
  });
}

/** Appends a link, extending the last one when both its sides continue it. */
function pushLink(out: RestorationLink[], link: RestorationLink) {
  const last = out[out.length - 1];
  if (
    last &&
    last[0] === link[0] &&
    last[1] + last[2] === link[1] &&
    last[3] === link[3] &&
    last[4] + last[2] === link[4]
  )
    out[out.length - 1] = [last[0], last[1], last[2] + link[2], last[3], last[4]];
  else out.push(link);
}

/** Both sides can be GC, including an intermediate link in an Undo/Redo chain. */
function known(
  doc: Y.Doc,
  client: number,
  end: number,
  missing?: (client: number, end: number) => void,
): boolean {
  if (Y.getState(doc.store, client) >= end) return true;
  missing?.(client, end);
  return false;
}

function sound(
  doc: Y.Doc,
  [client, clock, len, toClient, toClock]: RestorationLink,
  missing?: (client: number, end: number) => void,
): boolean {
  if (client < 0 || toClient < 0 || clock < 0 || toClock < 0 || len <= 0) return false;
  if (client === toClient && clock < toClock + len && toClock < clock + len) return false;
  return known(doc, client, clock + len, missing) && known(doc, toClient, toClock + len, missing);
}

/** The draft's write-backs and Undo evidence, validated without reading tombstone text. */
export function readRestorations(
  doc: Y.Doc,
  missing?: (client: number, end: number) => void,
): {
  base: ItemRange[];
  links: RestorationLink[];
  undone: ItemRange[];
} {
  const root = doc.share.get(RESTORED_ROOT);
  const out: { base: ItemRange[]; links: RestorationLink[]; undone: ItemRange[] } = {
    base: [],
    links: [],
    undone: [],
  };
  if (!root) return out;
  for (let item = (root as Y.Array<unknown>)._start; item; item = item.right) {
    if (item.deleted || !(item.content instanceof Y.ContentAny)) continue;
    for (const raw of item.content.getContent() as unknown[]) {
      if (!Array.isArray(raw) || !raw.every(Number.isSafeInteger)) continue;
      if (raw.length === 5) {
        const link = raw as unknown as RestorationLink;
        if (sound(doc, link, missing)) out.links.push(link);
      } else if (raw.length === 3 || (raw.length === 4 && raw[3] === 0)) {
        const range = raw.slice(0, 3) as unknown as ItemRange;
        const [client, clock, length] = range;
        if (client >= 0 && clock >= 0 && length > 0 && known(doc, client, clock + length, missing))
          (raw.length === 3 ? out.base : out.undone).push(range);
      }
    }
  }
  return out;
}
