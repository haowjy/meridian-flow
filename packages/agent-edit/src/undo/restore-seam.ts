import * as Y from "yjs";
import { findItem, marksAlong, type RestorePlacement } from "../yjs-mutation.js";
import { find, type Key, key, parse, ranges } from "./item-keys.js";

/** What a seam reads from the lineage: a copy an earlier Undo or Redo made stands for its original. */
interface SeamLineage {
  readonly doc: Y.Doc;
  root(k: Key): Key;
  isVisible(k: Key): boolean;
}
interface SeamInverse {
  /** The part's frontier: writing at or past it was done after the part. */
  frontier: Record<string, number>;
  /** Roots of every item the part inserted or deleted. */
  own: ReadonlySet<Key>;
  /** What the inverse brings back, as originals or copies. */
  returning: readonly Key[];
  /** Effective keys of what the inverse takes away. */
  leaving: ReadonlySet<Key>;
}
type Step = "left" | "right";

/**
 * Which text a part put in place of the text an inverse brings back, and where that text goes
 * back. Typing lands right of every tombstone at its position, so a writer's word typed before a
 * replacement sits between the replaced run's tombstone and the text that replaced it; Yjs would
 * restore the run left of that word. Reads the document and never writes: `classify` runs this
 * on the host's document, so pieces are per character and only the executor splits items.
 */
export function readSeams(lineage: SeamLineage, inverse: SeamInverse) {
  const { doc } = lineage,
    { frontier, own, leaving } = inverse;
  const returningRoots = new Set(inverse.returning.map((k) => lineage.root(k)));
  const leavingClients = new Set([...leaving].map((k) => parse(k).client));
  const charKey = (item: Y.Item, n: number) =>
    key({ client: item.id.client, clock: item.id.clock + n });
  const firstLeaving = (item: Y.Item): number => {
    if (!leavingClients.has(item.id.client)) return -1;
    for (let n = 0; n < item.length; n++) if (leaving.has(charKey(item, n))) return n;
    return -1;
  };
  const seenByPart = (k: Key) => {
    const root = lineage.root(k);
    if (own.has(root)) return false;
    const id = parse(root);
    return id.clock < (frontier[id.client] ?? 0);
  };
  /**
   * The seam beside an item on one side: the siblings the part could not see as text (tombstones,
   * marks, its own items and their copies, writing newer than its frontier), up to the first
   * leaving text, deleted or not, or the first visible text the part saw.
   */
  const walk = (item: Y.Item, step: Step) => {
    const crossed: Y.Item[] = [];
    for (let near = item[step]; near; near = near[step]) {
      if (near.countable && firstLeaving(near) >= 0) return { found: near, crossed };
      const edge = charKey(near, step === "left" ? near.length - 1 : 0);
      if (!near.deleted && near.countable && seenByPart(edge)) break;
      crossed.push(near);
    }
    return { found: null, crossed };
  };
  const originOf = (id: Y.ID, item: Y.Item): Y.ID | null =>
    id.clock > item.id.clock ? Y.createID(id.client, id.clock - 1) : item.origin;
  const leavingRoots = new Set([...leaving].map((k) => lineage.root(k)));
  /**
   * Whether the character `id` was inserted at text in `targets`: its original's origins (each
   * character's left neighbour when it was inserted, which never changes) lead back to it through
   * nothing but marks and the part's own items.
   */
  const insertedAt = (id: Y.ID, targets: ReadonlySet<Key>): boolean => {
    const original = parse(lineage.root(key(id))),
      first = findItem(doc, original);
    let at = first && originOf(original, first);
    while (at) {
      const item = findItem(doc, at);
      if (!item) return false;
      const root = lineage.root(key(at));
      if (item.countable && targets.has(root)) return true;
      if (!(item.content instanceof Y.ContentFormat) && !own.has(root)) return false;
      at = originOf(at, item);
    }
    return false;
  };
  /**
   * Whether the part put `found`, leaving text at the end of `item`'s seam, in place of `item`:
   * it inserted one where it deleted the other. In an Undo the leaving text is the insertion; in a
   * Redo, `item` is. Being beside it now proves nothing: the writer's later deletions make
   * unrelated text adjacent.
   */
  const replaced = (item: Y.Item, found: Y.Item): boolean =>
    insertedAt(parse(charKey(found, firstLeaving(found))), returningRoots) ||
    insertedAt(item.id, leavingRoots);
  return {
    /**
     * The text that replaced `item` still stands at the end of its seam, past the writer's
     * typing, so the writer did not replace it.
     */
    leavingStands(item: Y.Item): boolean {
      return (["left", "right"] as const).some((step) => {
        const { found } = walk(item, step);
        return !!found && !found.deleted && replaced(item, found);
      });
    },
    /**
     * Each run that comes back whole directly left of the text that replaced it, because visible
     * writing sits between the two. Every other piece stays with Yjs, at its tombstone. Only an
     * inverse being executed needs places.
     */
    placements(restoring: readonly Key[]): RestorePlacement[] {
      const pieces = new Map<Y.Item, Key[]>();
      for (const k of restoring) {
        const item = find(doc, k);
        if (!item || item.parentSub !== null || !(item.parent instanceof Y.XmlText)) continue;
        const home = item.parent._item;
        if (home && !lineage.isVisible(key(home.id))) continue;
        const list = pieces.get(item);
        if (list) list.push(k);
        else pieces.set(item, [k]);
      }
      const runEnd = (item: Y.Item, step: Step) => {
        const { found, crossed } = walk(item, step);
        const run: Y.Item[] = [];
        let inside = 0,
          outside = 0;
        for (const near of crossed) {
          if (pieces.has(near)) {
            run.push(near);
            inside += outside;
            outside = 0;
          } else if (!near.deleted && near.countable) outside++;
        }
        return { found, run, inside, outside };
      };
      // One fold per paragraph, however many runs in it come back.
      const folds = new Map<Y.XmlText, ReturnType<typeof marksAlong>>();
      const marksIn = (text: Y.XmlText) => {
        const known = folds.get(text);
        if (known) return known;
        const fold = marksAlong(text, (mark) => firstLeaving(mark) >= 0);
        folds.set(text, fold);
        return fold;
      };
      const out: RestorePlacement[] = [];
      const seen = new Set<Y.Item>();
      for (const item of pieces.keys()) {
        if (seen.has(item)) continue;
        const left = runEnd(item, "left"),
          right = runEnd(item, "right"),
          run = [item, ...left.run, ...right.run];
        for (const piece of run) seen.add(piece);
        // Writing inside the run stays inside it: the run comes back around it, at its tombstones.
        if (left.inside || right.inside) continue;
        // Only a run left of the leaving text can have writing between them that belongs before
        // it; touching it, Yjs's place is right. Between two replacements, the place is ambiguous.
        if (!right.found || !right.outside || left.found) continue;
        // Marks alone have no place to fix; moving them would only change what they cover.
        if (!run.some((piece) => piece.countable)) continue;
        if (!replaced(item, right.found)) continue;
        // The marks in force at each tombstone, leaving out the ones this inverse removes, must be
        // the ones at the new place, so the copy keeps its marks: an edge of someone's bold between
        // the two places keeps the run home.
        const marks = marksIn(right.found.parent as Y.XmlText),
          here = marks.get(right.found)?.marks;
        if (run.some((piece) => marks.get(piece)?.marks !== here)) continue;
        run.sort((a, b) => (marks.get(a)?.at ?? 0) - (marks.get(b)?.at ?? 0));
        out.push({
          ranges: run.flatMap((piece) => ranges(pieces.get(piece) ?? [])),
          before: parse(charKey(right.found, firstLeaving(right.found))),
        });
      }
      return out;
    },
  };
}
