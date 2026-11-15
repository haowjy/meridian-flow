import * as Y from "yjs";
import { marksAlong, type RestorePlacement } from "../yjs-mutation.js";
import { find, type Key, key, parse, ranges } from "./item-keys.js";

interface PairLineage {
  readonly doc: Y.Doc;
  root(k: Key): Key;
  effective(k: Key): Key;
  /** A root and every copy an Undo or Redo made of it. */
  descendants(k: Key): Key[];
  isVisible(k: Key): boolean;
}
/** One recorded replacement, seen from the inverse: what comes back, and the text put in its place. */
export interface PairSides {
  /** Original keys of the side the inverse brings back. */
  back: readonly Key[];
  /** Original keys of the side the inverse takes away. */
  gone: readonly Key[];
}
interface PairInverse {
  frontier: Record<string, number>;
  /** Roots of every item the part inserted or deleted. */
  own: ReadonlySet<Key>;
  pairs: readonly PairSides[];
  /** Effective keys of what the inverse takes away. */
  leaving: ReadonlySet<Key>;
  /** Whether a part in the history deleted this character, so an Undo or Redo can bring it back. */
  owned(k: Key): boolean;
}

/**
 * PROTOTYPE (#1591). Reads the recorded pairs of a part: whether the text that replaced a run
 * still stands, and where the run goes back. Nothing is inferred from neighbours or origins.
 */
export function readPairs(lineage: PairLineage, inverse: PairInverse) {
  const { doc } = lineage,
    { frontier, own, pairs, leaving, owned } = inverse;
  const pairOf = new Map<Key, number>();
  for (const [n, pair] of pairs.entries()) for (const k of pair.back) pairOf.set(k, n);
  const standing = new Map<number, Key[]>();
  /** The visible characters of the text that replaced pair `n`'s run, as effective keys. */
  const stands = (n: number): Key[] => {
    let known = standing.get(n);
    if (!known) {
      known = pairs[n].gone.map((k) => lineage.effective(k)).filter((k) => lineage.isVisible(k));
      standing.set(n, known);
    }
    return known;
  };
  const replacedPairs = new Map<number, boolean>();
  // As the stranded rule reads "written after the part": the original of a copy, by its clock.
  const newerThanPart = (k: Key) => {
    const id = parse(lineage.root(k));
    return id.clock >= (frontier[id.client] ?? 0);
  };
  const later = (k: Key) => {
    const root = lineage.root(k);
    if (own.has(root)) return false;
    const id = parse(root);
    return id.clock >= (frontier[id.client] ?? 0);
  };
  const charKey = (item: Y.Item, n: number) =>
    key({ client: item.id.client, clock: item.id.clock + n });
  return {
    /**
     * Whether the run `original` belongs to stays gone, from the record alone; `undefined` when no
     * replacement was recorded for it. It comes back while the text that replaced it stands, and
     * when that text was only deleted. It stays gone when writing made after the part stands
     * directly right of where that text was: the writer replaced it.
     */
    replacedSince(original: Key): boolean | undefined {
      const n = pairOf.get(original);
      if (n === undefined) return undefined;
      const known = replacedPairs.get(n);
      if (known !== undefined) return known;
      let replaced = false;
      if (!stands(n).length)
        for (const k of new Set(pairs[n].gone.flatMap((g) => lineage.descendants(lineage.root(g))))) {
          const item = find(doc, k);
          if (!item?.deleted) continue;
          let near = item.right;
          while (near && (near.deleted || !near.countable)) near = near.right;
          if (near && !leaving.has(charKey(near, 0)) && newerThanPart(charKey(near, 0))) {
            replaced = true;
            break;
          }
        }
      replacedPairs.set(n, replaced);
      return replaced;
    },
    /** Roots of the text recorded as replacing the run `original` belongs to. */
    replacementOf(original: Key): ReadonlySet<Key> | undefined {
      const n = pairOf.get(original);
      return n === undefined ? undefined : new Set(pairs[n].gone.map((k) => lineage.root(k)));
    },
    /** The run `original` belongs to was replaced by text that still stands. */
    replacementStands(original: Key): boolean {
      const n = pairOf.get(original);
      return n !== undefined && stands(n).length > 0;
    },
    placements(restoring: readonly Key[]): RestorePlacement[] {
      const restoringSet = new Set(restoring);
      const folds = new Map<Y.XmlText, ReturnType<typeof marksAlong>>();
      const marksIn = (text: Y.XmlText) => {
        let fold = folds.get(text);
        if (!fold) {
          fold = marksAlong(
            text,
            (mark) => leaving.has(key(mark.id)), // a format item is one clock long
          );
          folds.set(text, fold);
        }
        return fold;
      };
      const out: RestorePlacement[] = [];
      for (const [n, pair] of pairs.entries()) {
        const shown = stands(n);
        if (!shown.length) continue;
        // The run: this pair's returning characters that the inverse restores, by struct.
        const pieces = new Map<Y.Item, Key[]>();
        let text: Y.XmlText | null = null,
          apart = false;
        for (const original of pair.back) {
          const k = lineage.effective(original);
          if (!restoringSet.has(k)) continue;
          const item = find(doc, k);
          if (!item || item.parentSub !== null || !(item.parent instanceof Y.XmlText)) {
            apart = true;
            break;
          }
          if (text && item.parent !== text) {
            apart = true;
            break;
          }
          text = item.parent;
          const list = pieces.get(item);
          if (list) list.push(k);
          else pieces.set(item, [k]);
        }
        if (apart || !text || !pieces.size) continue;
        const home = text._item;
        if (home && !lineage.isVisible(key(home.id))) continue;
        const marks = marksIn(text);
        const at = (item: Y.Item) => marks.get(item)?.at ?? -1;
        // The anchor: the first standing character of the replacement, in reading order.
        let anchor: { item: Y.Item; k: Key } | null = null;
        for (const k of shown) {
          const item = find(doc, k);
          if (!item || item.parent !== text) continue;
          if (
            !anchor ||
            at(item) < at(anchor.item) ||
            (item === anchor.item && parse(k).clock < parse(anchor.k).clock)
          )
            anchor = { item, k };
        }
        if (!anchor) continue;
        const run = [...pieces.keys()].sort((a, b) => at(a) - at(b));
        const runKeys = new Set([...pieces.values()].flat());
        const back = new Set(pair.back.map((k) => lineage.root(k))),
          gone = new Set(pair.gone.map((k) => lineage.root(k)));
        // Whether a character was typed against the replacement: what stood right of the caret
        // when it was inserted (Yjs keeps it as `rightOrigin`, and it never changes) was the
        // replacement, or other writing typed against it. A peer who typed after the old word
        // without seeing the replacement had the next old word there instead.
        const typedAgainst = new Map<Key, boolean>();
        const against = (k: Key): boolean => {
          const root = lineage.root(k);
          const known = typedAgainst.get(root);
          if (known !== undefined) return known;
          typedAgainst.set(root, false);
          const next = find(doc, root)?.rightOrigin;
          const nextRoot = next ? lineage.root(key(next)) : null;
          const result =
            !!nextRoot &&
            !own.has(root) &&
            (gone.has(nextRoot) || (!back.has(nextRoot) && against(nextRoot)));
          typedAgainst.set(root, result);
          return result;
        };
        // A deleted character the run would be moved past must not be able to come back on the
        // wrong side of it: this pair's own, or typed against the replacement.
        const stays = (k: Key): boolean => {
          const root = lineage.root(k);
          if (back.has(root) || gone.has(root) || against(k)) return true;
          return !!process.env.CROSS_UNOWNED && !owned(k);
        };
        const first = run[0],
          last = run[run.length - 1];
        // Only a run left of its replacement can have writing between them that belongs before it.
        if (at(last) >= at(anchor.item)) continue;
        if (!run.some((piece) => piece.countable)) continue;
        // Character by character from the run's first to the anchor: one struct can hold the
        // run's characters and someone else's.
        let seen = 0,
          between = 0,
          clear = true,
          reached = false;
        const pending: { k: Key; deleted: boolean }[] = [];
        walk: for (let near: Y.Item | null = first; near; near = near.right) {
          if (!near.countable) {
            // A mark item is one clock long, and no character.
            if (key(near.id) === anchor.k) {
              reached = true;
              break;
            }
            if (runKeys.has(key(near.id))) seen++;
            continue;
          }
          for (let n = 0; n < near.length; n++) {
            const k = charKey(near, n);
            if (k === anchor.k) {
              reached = true;
              break walk;
            }
            if (runKeys.has(k)) {
              // Anything met since the last run character lies inside the run: writing inside
              // a word stays inside it, so the run comes back around it, at its tombstones.
              if (pending.some((unit) => !unit.deleted || !stays(unit.k))) clear = false;
              pending.length = 0;
              seen++;
            } else if (seen) pending.push({ k, deleted: near.deleted });
          }
        }
        // What is left lies between the run and its replacement: only writing typed against the
        // replacement, and some of it.
        for (const unit of pending) {
          if (unit.deleted) clear &&= stays(unit.k);
          else if (against(unit.k)) between++;
          else clear = false;
        }
        if (!reached || seen !== runKeys.size || !clear || !between) continue;
        const here = marks.get(anchor.item)?.marks;
        if (run.some((piece) => marks.get(piece)?.marks !== here)) continue;
        out.push({
          ranges: run.flatMap((piece) => ranges(pieces.get(piece) ?? [])),
          before: parse(anchor.k),
        });
      }
      return out;
    },
  };
}
