// Forward inverse receipts, cold lineage tracing, classification and admission.
import * as Y from "yjs";
import {
  intersectLineageRanges,
  type LineageRange,
  normalizeLineageRanges,
  subtractLineageRanges,
} from "../lineage/range-set.js";
import {
  ancestorItems,
  changedRedone,
  executeUndo,
  hydrateRedone,
  itemIsInFragment,
  itemIsVisible,
  itemsInRange,
  marksAlong,
  type RestorePlacement,
  snapshotRedone,
} from "../yjs-mutation.js";
import { shouldDeleteUndoItem } from "./delete-filter.js";
import { withoutClocks } from "./held-deletes.js";
import { clocks, find, type Key, key, parse, ranges } from "./item-keys.js";
import { readPairs } from "./restore-seam.js";
import { installHarnessRecorder, pendingReplacements } from "./replacement-record.js";

if (process.env.VITEST) installHarnessRecorder();

export interface EditRange {
  client: number;
  clock: number;
  len: number;
}
/** One splice of a text write: the run it deleted and the text it put in its place. */
export interface Replacement {
  deleted: EditRange[];
  inserted: EditRange[];
}
export interface EditEffect {
  inserted: EditRange[];
  deleted: EditRange[];
  /** Absent on a part stored before replacements were recorded. */
  replacements?: Replacement[];
}
export interface EditAlias {
  source: { client: number; clock: number };
  target: { client: number; clock: number };
  len: number;
}
export type EditFrontier = Record<string, number>;
export interface EditTarget {
  editId: string;
  ordinal: number;
  direction: "invert" | "reapply";
}
export type EditKind = "write" | "undo" | "redo" | "revert";
export interface InversePart {
  id: number;
  editId: string;
  ordinal: number;
  kind: EditKind;
  actionId?: string | null;
  update: Uint8Array;
  effect: EditEffect;
  frontier: EditFrontier;
  aliases: EditAlias[];
  targets: EditTarget[];
}
export type PartState = "active" | "undone" | "changed" | "excluded";
export interface PartClassification {
  part: InversePart;
  state: PartState;
  reasons: string[];
}
export interface CapturedPart {
  update: Uint8Array;
  effect: EditEffect;
  frontier: EditFrontier;
  aliases: EditAlias[];
}
export interface InverseSelection {
  part: InversePart;
  direction: "invert" | "reapply";
}
export interface ComputedInverseEdit {
  /** Host policy may give an edit its own stack action within an atomic command. */
  actionId?: string;
  targetEditId: string;
  parts: (CapturedPart & { targets: EditTarget[] })[];
}
export interface ComputedInverse {
  actionId: string;
  edits: ComputedInverseEdit[];
  skipped: PartClassification[];
}
const ROOT = "prosemirror";
const lineageRange = (range: EditRange): LineageRange => ({
  clientID: range.client,
  clock: range.clock,
  length: range.len,
});
const editRange = (range: LineageRange): EditRange => ({
  client: range.clientID,
  clock: range.clock,
  len: range.length,
});
const normalizedRanges = (ranges: readonly EditRange[]): EditRange[] =>
  normalizeLineageRanges(ranges.map(lineageRange)).map(editRange);
function proseRanges(doc: Y.Doc, input: readonly EditRange[]): EditRange[] {
  const out: EditRange[] = [];
  for (const range of input)
    for (const { item, clock, len } of itemsInRange(doc, range))
      if (inFragment(doc, item)) out.push({ client: range.client, clock, len });
  return normalizedRanges(out);
}
const inFragment = (doc: Y.Doc, item: Y.Item) => itemIsInFragment(doc, item, ROOT);
function rawEffect(update: Uint8Array, held?: ReadonlySet<string>): EditEffect {
  const decoded = Y.decodeUpdate(update);
  return {
    inserted: normalizedRanges(
      decoded.structs
        .filter((s): s is Y.Item => s instanceof Y.Item)
        .map((s) => ({ client: s.id.client, clock: s.id.clock, len: s.length })),
    ),
    deleted: normalizedRanges(
      withoutClocks(
        [...decoded.ds.clients].flatMap(([client, rs]) =>
          rs.map((r) => ({ client, clock: r.clock, len: r.len })),
        ),
        held,
      ),
    ),
  };
}
/** Capture before mutation, on the locked authoring document. Missing frontiers never default. */
export function captureEditFrontier(doc: Y.Doc): EditFrontier {
  return Object.fromEntries(Y.decodeStateVector(Y.encodeStateVector(doc)));
}
/**
 * Normalize the whole write together, excluding cross-part transients and non-prose roots.
 * `held` is `heldDeletes` taken before the update applied: a delete of an item the room had
 * already deleted is not the update's effect, so Undo never restores it.
 */
export function captureEditParts(
  doc: Y.Doc,
  receipts: readonly {
    update: Uint8Array;
    frontier: EditFrontier;
    held?: ReadonlySet<string>;
    replacements?: readonly Replacement[];
  }[],
): CapturedPart[] {
  const raw = receipts.map((r) => rawEffect(r.update, r.held));
  const inserted = normalizedRanges(raw.flatMap((effect) => effect.inserted)),
    deleted = normalizedRanges(raw.flatMap((effect) => effect.deleted)),
    transient = intersectLineageRanges(inserted.map(lineageRange), deleted.map(lineageRange));
  return receipts.map((receipt, i) => {
    if (!receipt.frontier) throw new Error("Missing edit frontier");
    const effect: EditEffect = {
      inserted: subtractLineageRanges(
        proseRanges(doc, raw[i].inserted).map(lineageRange),
        transient,
      ).map(editRange),
      deleted: subtractLineageRanges(
        proseRanges(doc, raw[i].deleted).map(lineageRange),
        transient,
      ).map(editRange),
    };
    // A pair is kept as far as both its sides are this part's effect: a held delete, a transient
    // or a non-prose item is no side of a replacement.
    const recorded = process.env.NO_RECORD
      ? undefined
      : (receipt.replacements ?? (process.env.VITEST ? pendingReplacements(doc) : undefined));
    if (recorded) {
      const within = (side: readonly EditRange[], all: readonly EditRange[]) =>
        intersectLineageRanges(side.map(lineageRange), all.map(lineageRange)).map(editRange);
      effect.replacements = recorded
        .map((pair) => ({
          deleted: within(pair.deleted, effect.deleted),
          inserted: within(pair.inserted, effect.inserted),
        }))
        .filter((pair) => pair.deleted.length && pair.inserted.length);
    }
    return { update: receipt.update, frontier: receipt.frontier, effect, aliases: [] };
  });
}

/** An invocation-local index, never a persisted-state cache. All alias branches remain evidence. */
class Lineage {
  readonly forward = new Map<Key, Key[]>();
  readonly backward = new Map<Key, Key>();
  readonly owners = new Map<Key, InversePart>();
  readonly inverseRestorations = new Set<Key>();
  readonly ordered: InversePart[];
  private readonly roots = new Map<Key, Key>();
  private readonly families = new Map<Key, Key[]>();
  private readonly effectRoots = new WeakMap<EditEffect, Key[]>();
  private readonly identities = new Map<Key, Key>();
  private readonly itemVisibility = new WeakMap<Y.Item, boolean>();
  isVisible(k: Key): boolean {
    const item = find(this.doc, k);
    if (!item) return false;
    if (!this.itemVisibility.has(item))
      this.itemVisibility.set(item, itemIsVisible(this.doc, item.id));
    return this.itemVisibility.get(item) === true;
  }
  private exists(k: Key): boolean {
    return !!find(this.doc, k);
  }
  constructor(
    readonly doc: Y.Doc,
    history: readonly InversePart[],
    base?: Lineage,
    added?: InversePart,
    sameView = false,
  ) {
    if (base && !added) {
      if (sameView) {
        this.identities = base.identities;
      }
      this.ordered = base.ordered;
      this.forward = base.forward;
      this.backward = base.backward;
      this.owners = base.owners;
      this.inverseRestorations = base.inverseRestorations;
      this.roots = base.roots;
      this.families = base.families;
      this.effectRoots = base.effectRoots;
      return;
    }
    this.ordered = [...history].sort((a, b) => a.id - b.id);
    if (base) {
      this.forward = new Map(base.forward);
      this.backward = new Map(base.backward);
      this.owners = new Map(base.owners);
      this.inverseRestorations = new Set(base.inverseRestorations);
      this.roots = new Map(base.roots);
    }
    for (const p of added ? [added] : this.ordered) {
      for (const k of clocks(p.effect.deleted)) if (!this.owners.has(k)) this.owners.set(k, p);
      for (const alias of p.aliases)
        for (let n = 0; n < alias.len; n++) {
          const source = key({ client: alias.source.client, clock: alias.source.clock + n }),
            target = key({ client: alias.target.client, clock: alias.target.clock + n });
          if (this.backward.has(target) && this.backward.get(target) !== source)
            throw new Error("Conflicting restoration aliases");
          if (p.kind !== "write") this.inverseRestorations.add(source);
          this.backward.set(target, source);
          const links = this.forward.get(source) ?? [];
          if (base) {
            this.forward.set(source, [...links, target]);
            continue;
          }
          links.push(target);
          this.forward.set(source, links);
        }
    }
  }
  descendants(k: Key): Key[] {
    const cached = this.families.get(k);
    if (cached) return cached;
    const out: Key[] = [],
      seen = new Set<Key>();
    const walk = (source: Key) => {
      if (seen.has(source)) return;
      seen.add(source);
      out.push(source);
      for (const target of this.forward.get(source) ?? []) walk(target);
    };
    walk(k);
    this.families.set(k, out);
    return out;
  }
  root(k: Key): Key {
    const cached = this.roots.get(k);
    if (cached) return cached;
    if (!this.backward.has(k)) return k;
    const path = new Set<Key>();
    let current = k;
    while (this.backward.has(current) && !this.roots.has(current)) {
      if (path.has(current)) throw new Error("Cyclic restoration lineage");
      path.add(current);
      current = this.backward.get(current) ?? current;
    }
    const root = this.roots.get(current) ?? current;
    for (const member of path) this.roots.set(member, root);
    return root;
  }
  rootsFor(effect: EditEffect): Key[] {
    let roots = this.effectRoots.get(effect);
    if (!roots) {
      roots = [
        ...new Set(clocks([...effect.inserted, ...effect.deleted]).map((k) => this.root(k))),
      ];
      this.effectRoots.set(effect, roots);
    }
    return roots;
  }
  effective(k: Key): Key {
    const root = this.root(k),
      cached = this.identities.get(root);
    if (cached) return cached;
    const descendants = this.descendants(root);
    const shown = descendants.filter((member) => this.isVisible(member));
    if (shown.length > 1) throw new Error("Multiple visible restorations of one root");
    const effective =
      shown[0] ?? [...descendants].reverse().find((member) => this.exists(member)) ?? k;
    this.identities.set(root, effective);
    return effective;
  }
  restored(k: Key): boolean {
    return this.descendants(this.root(k)).some((source) => this.inverseRestorations.has(source));
  }
  hydrate(): void {
    const summaries = new Map<Key, { shown?: Key; last?: Key }>();
    const visiting = new Set<Key>();
    const summarize = (source: Key): { shown?: Key; last?: Key } => {
      const cached = summaries.get(source);
      if (cached) return cached;
      if (visiting.has(source)) throw new Error("Cyclic restoration lineage");
      visiting.add(source);
      const result: { shown?: Key; last?: Key } = {
        shown: this.isVisible(source) ? source : undefined,
        last: this.exists(source) ? source : undefined,
      };
      for (const target of this.forward.get(source) ?? []) {
        const child = summarize(target);
        result.shown ??= child.shown;
        result.last = child.last ?? result.last;
      }
      visiting.delete(source);
      summaries.set(source, result);
      return result;
    };
    const pairs: { source: Y.ID; target: Y.ID }[] = [];
    for (const source of this.forward.keys()) {
      let shown: Key | undefined, last: Key | undefined;
      for (const target of this.forward.get(source) ?? []) {
        const child = summarize(target);
        shown ??= child.shown;
        last = child.last ?? last;
      }
      const target = shown ?? last;
      if (target && this.exists(source))
        pairs.push({ source: parse(source), target: parse(target) });
    }
    hydrateRedone(this.doc, pairs);
  }
}

/**
 * What Undo (`invert`) or Redo (`reapply`) of one part does now, item by item: remove the items
 * it would take away, restore the ones it would bring back, leave everything else, including
 * every other peer's typing. An item that is already gone, or whose parent or newer map value
 * belongs to someone else, is skipped rather than refusing the part.
 */
interface InversePlan {
  /** Every item the direction would remove, still visible or not: the stack item's insertions. */
  removing: Key[];
  /** Only the items that can come back now: Yjs copies an item it is told to restore. */
  restoring: Key[];
  acts: boolean;
  /** A restore skipped because its parent is gone. */
  blocked: boolean;
  /** The runs of `restoring` that go back beside the text that replaced them, not at their tombstones. */
  place: () => RestorePlacement[];
  /** `main`'s stranded rule, not the record, decided a run that has a recorded replacement. */
  inferredOut: boolean;
}
function planInverse(
  index: Lineage,
  part: InversePart,
  direction: "invert" | "reapply",
): InversePlan {
  const forward = direction === "invert";
  const pairs = (list: readonly EditRange[]) =>
    clocks(list).map((original) => ({ original, effective: index.effective(original) }));
  const removing = pairs(forward ? part.effect.inserted : part.effect.deleted);
  const returning = pairs(forward ? part.effect.deleted : part.effect.inserted);
  const removingKeys = removing.map((pair) => pair.effective);
  const removingSet = new Set(removingKeys);
  const insertions = deleteSet(removingKeys);
  const authorized = (k: Key) => {
    const owner = index.owners.get(k);
    return !!owner && (owner.kind !== "write" || owner.editId === part.editId);
  };
  // The recorded pairs, read only for a run the stranded rule would keep out or an executing inverse.
  let read: ReturnType<typeof readPairs> | undefined;
  const recordedPairs = () =>
    (read ??= readPairs(index, {
      frontier: part.frontier,
      own: new Set(index.rootsFor(part.effect)),
      pairs: (part.effect.replacements ?? []).map((pair) => ({
        back: clocks(forward ? pair.deleted : pair.inserted),
        gone: clocks(forward ? pair.inserted : pair.deleted),
      })),
      leaving: removingSet,
      owned: (k) => index.owners.has(k),
    }));
  // A replacement is a deleted run with the part's insertion beside it. Bringing the deleted run back
  // alone doubles the text only when that insertion is gone and someone wrote there after the part
  // (a replacement by the writer or a pull); a plain deletion of the insertion leaves the gap empty.
  // While the text the part put in its place still stands, past the writer's typing, it was not replaced.
  const removingItems = new Set<Y.Item>();
  for (const { original } of removing) {
    const item = find(index.doc, original);
    if (item) removingItems.add(item);
  }
  const strandedItems = new Map<Y.Item, boolean>();
  const strandedByRemoval = (original: Key): boolean => {
    const item = find(index.doc, original);
    if (!item) return false;
    const known = strandedItems.get(item);
    if (known !== undefined) return known;
    let paired = false,
      standing = false,
      newer = false;
    for (const step of ["left", "right"] as const) {
      let near = item[step];
      for (; near?.deleted; near = near[step]) paired ||= removingItems.has(near);
      if (!near) continue;
      // The character touching the gap, followed back to its original: an Undo- or Redo-restored
      // copy has a client the part's frontier never saw, but it is not newer writing.
      const edge = key({
        client: near.id.client,
        clock: near.id.clock + (step === "left" ? near.length - 1 : 0),
      });
      if (removingSet.has(edge)) standing = true;
      else {
        const origin = parse(index.root(edge));
        newer ||= origin.clock >= (part.frontier[origin.client] ?? 0);
      }
    }
    const stranded = paired && !standing && newer;
    strandedItems.set(item, stranded);
    return stranded;
  };
  // Later writing counts against a recorded run only on the side its replacement stood: writing
  // on the far side of the run was never typed in the replacement's place.
  const onlyFarSide = (original: Key): boolean => {
    const roots = recordedPairs().replacementOf(original),
      item = find(index.doc, original);
    if (!roots || !item) return false;
    let crossed = false,
      newerThere = false;
    for (const step of ["left", "right"] as const) {
      let near = item[step],
        own = false;
      for (; near?.deleted; near = near[step])
        for (let n = 0; !own && n < near.length; n++)
          own = roots.has(index.root(key({ client: near.id.client, clock: near.id.clock + n })));
      if (!own) continue;
      crossed = true;
      if (!near) continue;
      const edge = key({
        client: near.id.client,
        clock: near.id.clock + (step === "left" ? near.length - 1 : 0),
      });
      if (removingSet.has(edge)) continue;
      const origin = parse(index.root(edge));
      newerThere ||= origin.clock >= (part.frontier[origin.client] ?? 0);
    }
    return crossed && !newerThere;
  };
  let inferredOut = false;
  const candidates = new Set(
    returning
      // One struct can hold characters of two pairs, so the record is asked per character.
      .filter(({ original }) => {
        if (!process.env.RECORD_STRAND)
        {
          if (recordedPairs().replacementStands(original)) return true;
          // The record no longer settles this run: `main`'s rule decides it, either way.
          if (recordedPairs().replacementOf(original)) inferredOut = true;
          if (!strandedByRemoval(original)) return true;
          if (process.env.SIDE && onlyFarSide(original)) return true;
          return false;
        }
        const recorded = part.effect.replacements?.length
          ? recordedPairs().replacedSince(original)
          : undefined;
        return recorded === undefined ? !strandedByRemoval(original) : !recorded;
      })
      .map((pair) => pair.effective)
      .filter((k) => !!find(index.doc, k) && !index.isVisible(k) && authorized(k)),
  );
  const standing = new Map<Key, "ok" | "parent" | "superseded">();
  const verdict = (k: Key): "ok" | "parent" | "superseded" => {
    const known = standing.get(k);
    if (known) return known;
    standing.set(k, "parent");
    const item = find(index.doc, k) as Y.Item;
    // Yjs restores a map entry only while nothing newer than the undone edit has replaced it.
    const superseded =
      item.parentSub !== null &&
      itemsRightOf(item).some((newer) => !removingSet.has(key(newer.id)));
    const parent = ancestorItems(item)[0],
      home = parent && index.effective(key(parent.id));
    const result = superseded
      ? "superseded"
      : !home || index.isVisible(home) || (candidates.has(home) && verdict(home) === "ok")
        ? "ok"
        : "parent";
    standing.set(k, result);
    return result;
  };
  const verdicts = [...candidates].map((k) => ({ k, verdict: verdict(k) }));
  const restoring = verdicts.filter((v) => v.verdict === "ok").map((v) => v.k);
  const stackItem = { insertions, meta: new Map() };
  const removable = removing.some(({ original, effective }) => {
    const item = find(index.doc, effective);
    return (
      !!item &&
      index.isVisible(effective) &&
      (forward || index.restored(original)) &&
      shouldDeleteUndoItem(item, stackItem)
    );
  });
  return {
    removing: removingKeys,
    restoring,
    acts: removable || restoring.length > 0,
    blocked: verdicts.some((v) => v.verdict === "parent"),
    inferredOut,
    place: () => (part.effect.replacements?.length ? recordedPairs().placements(restoring) : []),
  };
}
function itemsRightOf(item: Y.Item): Y.Item[] {
  const out: Y.Item[] = [];
  for (let right = item.right; right; right = right.right) out.push(right);
  return out;
}

function classify(index: Lineage, part: InversePart): PartClassification {
  const changed = (reason: string): PartClassification => ({
    part,
    state: "changed",
    reasons: [reason],
  });
  if (!part.frontier) return changed("missing frontier");
  if (!part.effect.inserted.length && !part.effect.deleted.length)
    return { part, state: "excluded", reasons: [] };
  try {
    const undo = planInverse(index, part, "invert");
    if (undo.acts) return { part, state: "active", reasons: [] };
    if (planInverse(index, part, "reapply").acts) return { part, state: "undone", reasons: [] };
    return changed(undo.blocked ? "inaccessible ancestor" : "nothing left to undo");
  } catch (error) {
    return changed(error instanceof Error ? error.message : String(error));
  }
}
type Unit = { k: Key; ch: string; marks: string } | null;
/** A text block's visible characters in reading order, with the marks on each; `null` is an inline atom. */
function blockUnits(block: Y.AbstractType<unknown>): Unit[] {
  const out: Unit[] = [];
  for (let child = block._start; child; child = child.right) {
    if (child.deleted) continue;
    const text = child.content instanceof Y.ContentType ? child.content.type : null;
    if (!(text instanceof Y.XmlText)) {
      out.push(null);
      continue;
    }
    for (const [item, { marks }] of marksAlong(text)) {
      if (item.deleted) continue;
      if (item.content instanceof Y.ContentString)
        for (let n = 0; n < item.length; n++)
          out.push({
            k: key({ client: item.id.client, clock: item.id.clock + n }),
            ch: item.content.str[n],
            marks,
          });
      else if (!(item.content instanceof Y.ContentFormat)) out.push(null);
    }
  }
  return out;
}
/**
 * Each word (a run with no whitespace and no atom) that holds a character `later` accepts, by that
 * character: the word's text and the marks on its accepted characters.
 */
function laterWords(
  units: readonly Unit[],
  later: (k: Key) => boolean,
  withMarks: boolean,
): Map<Key, string> {
  const out = new Map<Key, string>();
  let word: { k: Key; ch: string; marks: string }[] = [];
  const close = () => {
    const held = word.filter((unit) => later(unit.k));
    if (held.length) {
      const str = JSON.stringify([
        word.map((unit) => unit.ch).join(""),
        withMarks ? held.map((u) => u.marks) : [],
      ]);
      for (const unit of held) out.set(unit.k, str);
    }
    word = [];
  };
  for (const unit of units) {
    if (unit && !/\s/.test(unit.ch)) word.push(unit);
    else close();
  }
  close();
  return out;
}
/**
 * Whether the inverse that took `before` to `after` changed a word holding later writing, or the
 * marks on that writing: a
 * visible character written after `part` (a clock at or past its frontier, read on the original
 * of an Undo- or Redo-restored copy) that is not the part's own.
 */
function changesLaterWord(
  index: Lineage,
  part: InversePart,
  before: Y.Doc,
  after: Y.Doc,
  receipt: CapturedPart,
  withMarks: boolean,
): boolean {
  const own = new Set(index.rootsFor(part.effect));
  const later = (k: Key) => {
    const root = index.root(k);
    if (own.has(root)) return false;
    const origin = parse(root);
    return origin.clock >= (part.frontier[origin.client] ?? 0);
  };
  const blocks = new Map<Key, Y.Item>();
  for (const range of [...receipt.effect.inserted, ...receipt.effect.deleted])
    for (const { item } of itemsInRange(after, range)) {
      const parent = item.parent instanceof Y.XmlText ? item.parent._item?.parent : item.parent;
      const block = parent instanceof Y.AbstractType ? parent._item : null;
      if (block) blocks.set(key(block.id), block);
    }
  for (const [k, block] of blocks) {
    const was = find(before, k);
    if (!was || !(was.content instanceof Y.ContentType)) continue;
    const words = laterWords(blockUnits(was.content.type), later, withMarks);
    if (!words.size) continue;
    const now = laterWords(
      block.deleted ? [] : blockUnits((block.content as Y.ContentType).type),
      (unit) => words.has(unit),
      withMarks,
    );
    for (const [unit, word] of words) if (now.get(unit) !== word) return true;
  }
  return false;
}
/** Dry run only. Policy decides selection, destination, locking and partial acceptance. */
export function classifyEditParts(
  doc: Y.Doc,
  history: readonly InversePart[],
  parts: readonly InversePart[],
): PartClassification[] {
  const index = new Lineage(doc, history);
  return parts.map((p) => classify(index, p));
}
function deleteSet(keys: Iterable<Key>): ReturnType<typeof Y.createDeleteSet> {
  const ds = Y.createDeleteSet();
  for (const r of ranges(keys)) {
    const rs = ds.clients.get(r.client) ?? [];
    rs.push({ clock: r.clock, len: r.len });
    ds.clients.set(r.client, rs);
  }
  return ds;
}
function captureAliases(doc: Y.Doc, before: Map<Key, Key | undefined>): EditAlias[] {
  const pairs = changedRedone(doc, before).map(({ source, target }) => ({
    source: key(source),
    target: key(target),
  }));
  const out: EditAlias[] = [];
  for (const { source, target } of pairs) {
    const s = parse(source),
      t = parse(target),
      last = out.at(-1);
    if (
      last &&
      last.source.client === s.client &&
      last.target.client === t.client &&
      last.source.clock + last.len === s.clock &&
      last.target.clock + last.len === t.clock
    )
      last.len++;
    else out.push({ source: s, target: t, len: 1 });
  }
  return out;
}
/** Verify the server-owned receipt against the pre-inverse locked view and accepted parts. */
export function admitInverseReceipt(
  doc: Y.Doc,
  history: readonly InversePart[],
  accepted: readonly InversePart[],
  receipt: CapturedPart,
): void {
  admitPreparedInverseReceipt(doc, history, accepted, receipt);
}

function admitPreparedInverseReceipt(
  doc: Y.Doc,
  history: readonly InversePart[],
  accepted: readonly InversePart[],
  receipt: CapturedPart,
  prepared?: Lineage,
): void {
  const index = new Lineage(doc, history, prepared, undefined, true);
  const allowed = new Set(
    accepted
      .flatMap((p) => clocks([...p.effect.inserted, ...p.effect.deleted]))
      .map((k) => index.effective(k)),
  );
  for (const k of clocks(rawEffect(receipt.update).deleted))
    if (!allowed.has(k)) throw new Error("Inverse deletes outside accepted parts");
  const after = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(after, Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(after, receipt.update);
    if (after.store.pendingStructs || after.store.pendingDs)
      throw new Error("Inverse has pending integration");
    const aliases = new Set(receipt.aliases.flatMap((a) => clocks([{ ...a.target, len: a.len }])));
    for (const k of clocks(captureEditParts(after, [receipt])[0].effect.inserted))
      if (!aliases.has(k)) throw new Error("Restored item has no alias");
    const addition: InversePart = {
      ...receipt,
      id: Math.max(0, ...history.map((p) => p.id)) + 1,
      editId: "admission",
      ordinal: 0,
      kind: "undo",
      targets: [],
    };
    const merged = receipt.aliases.length
      ? new Lineage(after, [...history, addition], index, addition)
      : index;
    for (const alias of receipt.aliases) {
      for (const source of clocks([{ ...alias.source, len: alias.len }])) {
        const root = index.root(source);
        if (!allowed.has(index.effective(root)))
          throw new Error("Restoration alias outside accepted parts");
        merged.effective(root);
      }
    }
  } finally {
    after.destroy();
  }
}
export interface InverseAction {
  actionId: string;
  allocateClient: (doc: Y.Doc) => number;
  /** Leave a part standing (`changed`) when its inverse would change a word holding later writing. */
  keepLaterWords?: boolean;
}
/** Compute on an owned cold replica. The caller admits/persists the deltas under its lock. */
export function computeInverse(
  doc: Y.Doc,
  history: readonly InversePart[],
  selection: readonly InverseSelection[],
  action: InverseAction,
): ComputedInverse {
  return computePreparedInverse(doc, history, selection, action);
}

function computePreparedInverse(
  doc: Y.Doc,
  history: readonly InversePart[],
  selection: readonly InverseSelection[],
  action: InverseAction,
  prepared?: Lineage,
): ComputedInverse {
  if (!action.actionId) throw new Error("Inverse requires an action ID");
  if (!selection.length) return { actionId: action.actionId, edits: [], skipped: [] };
  let scratch = new Y.Doc({ gc: false });
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  const local = [...history],
    result: ComputedInverse = { actionId: action.actionId, edits: [], skipped: [] };
  const groups = new Map<string, ComputedInverseEdit>();
  const directions = new Map<string, string>();
  try {
    for (const chosen of selection) {
      const prior = directions.get(chosen.part.editId);
      if (prior && prior !== chosen.direction)
        throw new Error("One target edit cannot transition both ways");
      directions.set(chosen.part.editId, chosen.direction);
    }
    for (const { part: chosen, direction } of selection) {
      // Un-Apply tries the recorded replacements first and keeps the result only when it leaves
      // later writing's words and marks alone; otherwise the part runs as one with no record.
      const recorded = !!chosen.effect.replacements?.length && !process.env.NO_PAIRS;
      const bare: InversePart = recorded
        ? { ...chosen, effect: { inserted: chosen.effect.inserted, deleted: chosen.effect.deleted } }
        : chosen;
      const attempts =
        recorded && action.keepLaterWords && !process.env.NO_FALLBACK
          ? [chosen, bare]
          : [recorded ? chosen : bare];
      for (const [n, part] of attempts.entries()) {
        const final = n === attempts.length - 1;
        const index = new Lineage(
            scratch,
            local,
            local.length === history.length ? prepared : undefined,
            undefined,
            true,
          ),
          state = classify(index, part);
        if (state.state !== (direction === "invert" ? "active" : "undone")) {
          result.skipped.push({ ...state, part: chosen });
          break;
        }
        index.hydrate();
        const plan = planInverse(index, part, direction);
        // Un-Apply uses the record only where it settles every recorded run of the part.
        if (!final && plan.inferredOut && !process.env.NO_STRICT_KEEP) continue;
        const placements = plan.place(),
          placed = new Set(placements.flatMap((placement) => clocks(placement.ranges)));
        const stack = {
          insertions: deleteSet(plan.removing),
          deletions: deleteSet(plan.restoring.filter((k) => !placed.has(k))),
          meta: new Map(),
        };
        const frontier = captureEditFrontier(scratch),
          snapshot = snapshotRedone(scratch);
        const client = action.allocateClient(scratch);
        if (frontier[client] !== undefined) throw new Error("Inverse client is not fresh");
        let before = new Y.Doc({ gc: false });
        Y.applyUpdate(before, Y.encodeStateAsUpdate(scratch));
        let updates: Uint8Array[];
        try {
          updates = executeUndo(
            scratch,
            ROOT,
            client,
            stack,
            (item) => shouldDeleteUndoItem(item, stack),
            placements,
          );
        } catch (error) {
          before.destroy();
          throw error;
        }
        try {
          if (!updates.length) break;
          const update = Y.mergeUpdates(updates),
            receipt = captureEditParts(scratch, [{ update, frontier }])[0];
          receipt.aliases = captureAliases(scratch, snapshot);
          if (
            action.keepLaterWords &&
            changesLaterWord(index, part, before, scratch, receipt, part !== bare)
          ) {
            [scratch, before] = [before, scratch];
            if (!final) continue;
            result.skipped.push({
              part: chosen,
              state: "changed",
              reasons: ["later writing in its word"],
            });
            break;
          }
          admitPreparedInverseReceipt(before, local, [chosen], receipt, index);
          const targets: EditTarget[] = [
            { editId: chosen.editId, ordinal: chosen.ordinal, direction },
          ];
          let edit = groups.get(chosen.editId);
          if (!edit) {
            edit = { targetEditId: chosen.editId, parts: [] };
            groups.set(chosen.editId, edit);
            result.edits.push(edit);
          }
          edit.parts.push({ ...receipt, targets });
          local.push({
            ...receipt,
            targets,
            id: Math.max(0, ...local.map((p) => p.id)) + 1,
            editId: `computed:${result.edits.indexOf(edit)}`,
            ordinal: edit.parts.length - 1,
            kind: direction === "invert" ? "undo" : "redo",
            actionId: action.actionId,
          });
          break;
        } finally {
          before.destroy();
        }
      }
    }
    for (const edit of result.edits) {
      const normalized = captureEditParts(scratch, edit.parts);
      edit.parts = edit.parts.map((p, i) => ({ ...p, effect: normalized[i].effect }));
    }
    return result;
  } finally {
    scratch.destroy();
  }
}

/** One immutable-view lineage for host inspection and inverses; discard before mutation. */
export function prepareEditRoots(doc: Y.Doc, history: readonly InversePart[]): PreparedEditRoots {
  return preparedRoots(new Lineage(doc, history));
}
export interface PreparedEditRoots {
  forView(doc: Y.Doc): PreparedEditRoots;
  classify(parts: readonly InversePart[]): PartClassification[];
  compute(selection: readonly InverseSelection[], action: InverseAction): ComputedInverse;
  roots(effect: EditEffect): string[];
  inspect(roots: Iterable<string>): { root: string; identity: string | null }[];
}
function preparedRoots(index: Lineage): PreparedEditRoots {
  const { doc, ordered: history } = index;
  return {
    forView(view) {
      return preparedRoots(new Lineage(view, history, index));
    },
    classify(parts) {
      return parts.map((part) => classify(index, part));
    },
    compute(selection, action) {
      return computePreparedInverse(doc, history, selection, action, index);
    },
    roots(effect: EditEffect): string[] {
      return index.rootsFor(effect);
    },
    inspect(roots: Iterable<string>): { root: string; identity: string | null }[] {
      return [...roots].map((root) => {
        const effective = index.effective(root);
        return { root, identity: index.isVisible(effective) ? effective : null };
      });
    },
  };
}

/** Visible identity by restoration root, used by host-owned cross-view holds. */
export function inspectEditRoots(doc: Y.Doc, history: readonly InversePart[], effect: EditEffect) {
  const index = prepareEditRoots(doc, history);
  return index.inspect(index.roots(effect));
}
