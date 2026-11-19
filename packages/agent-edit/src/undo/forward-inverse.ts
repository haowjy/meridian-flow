// Forward inverse receipts, cold lineage tracing, classification and admission.
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
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
  findItem,
  hydrateRedone,
  itemIsInFragment,
  itemIsVisible,
  itemsInRange,
  snapshotRedone,
} from "../yjs-mutation.js";
import { shouldDeleteUndoItem } from "./delete-filter.js";
import { withoutClocks } from "./held-deletes.js";

export interface EditRange {
  client: number;
  clock: number;
  len: number;
}
/** One replace: the deleted runs and the inserted text that took their place. */
export interface EditChange {
  deleted: EditRange[];
  inserted: EditRange[];
}
export interface EditEffect {
  inserted: EditRange[];
  deleted: EditRange[];
  /**
   * The replaces of the write, paired from the document right after that write. A deleted item
   * in none of them is a pure deletion. Absent on a receipt written before it was recorded and on
   * one that can't be undone.
   */
  replaced?: EditChange[];
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
}
export type EditKind = "write" | "undo" | "revert";
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
export type PartState = "active" | "changed" | "excluded";
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
type Key = string;
const key = (id: { client: number; clock: number }): Key => `${id.client}:${id.clock}`;
const parse = (k: Key): Y.ID => {
  const separator = k.indexOf(":");
  return Y.createID(Number(k.slice(0, separator)), Number(k.slice(separator + 1)));
};
const clocks = (ranges: readonly EditRange[]): Key[] =>
  ranges.flatMap((r) =>
    Array.from({ length: r.len }, (_, n) => key({ client: r.client, clock: r.clock + n })),
  );
function ranges(keys: Iterable<Key>): EditRange[] {
  const sorted = [...new Set(keys)]
    .map(parse)
    .sort((a, b) => a.client - b.client || a.clock - b.clock);
  const out: EditRange[] = [];
  for (const id of sorted) {
    const last = out.at(-1);
    if (last?.client === id.client && last.clock + last.len === id.clock) last.len++;
    else out.push({ ...id, len: 1 });
  }
  return out;
}
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
const find = (doc: Y.Doc, k: Key) => findItem(doc, parse(k)) ?? undefined;
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
 * The replaces of one write, from the item structure. Call it right after `update` applied to
 * `doc`, before any later write changes the document: a deletion made by a later write would
 * otherwise read as one from before this write. Only a receipt that can be undone needs it.
 */
export function pairEdit(
  doc: Y.Doc,
  receipt: { update: Uint8Array; frontier: EditFrontier; held?: ReadonlySet<string> },
): EditChange[] {
  const raw = rawEffect(receipt.update, receipt.held);
  const effect = {
    inserted: proseRanges(doc, raw.inserted),
    deleted: proseRanges(doc, raw.deleted),
  };
  return effect.inserted.length && effect.deleted.length
    ? pairChanges(doc, receipt.frontier, effect, (k) => k)
    : [];
}
/**
 * Normalize the whole write together, excluding cross-part transients and non-prose roots.
 * `held` is `heldDeletes` taken before the update applied: a delete of an item the room had
 * already deleted is not the update's effect, so Undo never restores it. `replaced` is the
 * receipt's `pairEdit`, taken at its own write; the transients are dropped from it, never
 * paired again here.
 */
export function captureEditParts(
  doc: Y.Doc,
  receipts: readonly {
    update: Uint8Array;
    frontier: EditFrontier;
    held?: ReadonlySet<string>;
    replaced?: readonly EditChange[];
  }[],
): CapturedPart[] {
  const raw = receipts.map((r) => rawEffect(r.update, r.held));
  const inserted = normalizedRanges(raw.flatMap((effect) => effect.inserted)),
    deleted = normalizedRanges(raw.flatMap((effect) => effect.deleted)),
    transient = intersectLineageRanges(inserted.map(lineageRange), deleted.map(lineageRange));
  const outside = (input: readonly EditRange[]) =>
    subtractLineageRanges(input.map(lineageRange), transient).map(editRange);
  return receipts.map((receipt, i) => {
    if (!receipt.frontier) throw new Error("Missing edit frontier");
    const effect: EditEffect = {
      inserted: outside(proseRanges(doc, raw[i].inserted)),
      deleted: outside(proseRanges(doc, raw[i].deleted)),
    };
    if (receipt.replaced)
      effect.replaced = receipt.replaced
        .map((change) => ({ deleted: outside(change.deleted), inserted: outside(change.inserted) }))
        .filter((change) => change.deleted.length && change.inserted.length);
    return { update: receipt.update, frontier: receipt.frontier, effect, aliases: [] };
  });
}

/** An invocation-local index, never a persisted-state cache. All alias branches remain evidence. */
class Lineage {
  readonly forward = new Map<Key, Key[]>();
  readonly backward = new Map<Key, Key>();
  readonly owners = new Map<Key, InversePart>();
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
 * What Undo of one part does now, item by item: remove the items its edit inserted, restore the
 * ones it deleted, leave everything else, including every other peer's typing. An item that is already gone, or whose parent or newer map value
 * belongs to someone else, is skipped rather than refusing the part.
 */
interface InversePlan {
  /** Every item the Undo would remove, still visible or not: the stack item's insertions. */
  removing: Key[];
  /** Only the items that can come back now: Yjs copies an item it is told to restore. */
  restoring: Key[];
  acts: boolean;
  /** A restore skipped because its parent is gone. */
  blocked: boolean;
}
function planInverse(index: Lineage, part: InversePart): InversePlan {
  const pairs = (list: readonly EditRange[]) =>
    clocks(list).map((original) => ({ original, effective: index.effective(original) }));
  const removingRanges = part.effect.inserted;
  const returning = pairs(part.effect.deleted);
  // Classifying only asks whether the plan acts, which the first visible item usually answers,
  // so the effective identity of every removed item is resolved only when the plan is used.
  const removing = lazy(() => pairs(removingRanges));
  const removingKeys = lazy(() => removing().map((pair) => pair.effective));
  const removingSet = lazy(() => new Set(removingKeys()));
  const insertions = lazy(() => deleteSet(removingKeys()));
  const authorized = (k: Key) => {
    const owner = index.owners.get(k);
    return !!owner && (owner.kind !== "write" || owner.editId === part.editId);
  };
  const gone = replacedGone(index, part);
  const candidates = new Set(
    returning
      // A change whose new text is gone has nothing to undo.
      .filter((pair) => !gone(pair.original))
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
      itemsRightOf(item).some((newer) => !removingSet().has(key(newer.id)));
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
  const stackItem = {
    get insertions() {
      return insertions();
    },
    meta: new Map(),
  };
  // A container or attribute is judged against every removed item, a text item on its own: look
  // at the text first, and let the containers settle it only when no text can.
  const deferred: Key[] = [];
  const removes = (original: Key) => {
    const effective = index.effective(original);
    const item = find(index.doc, effective);
    return !!item && index.isVisible(effective) && shouldDeleteUndoItem(item, stackItem);
  };
  let removable = false;
  for (const range of removingRanges) {
    for (let n = 0; n < range.len && !removable; n++) {
      const original = key({ client: range.client, clock: range.clock + n });
      const item = find(index.doc, index.effective(original));
      if (item && (item.content instanceof Y.ContentType || item.parentSub !== null))
        deferred.push(original);
      else removable = removes(original);
    }
  }
  removable ||= deferred.some(removes);
  return {
    get removing() {
      return removingKeys();
    },
    restoring,
    acts: removable || restoring.length > 0,
    blocked: verdicts.some((v) => v.verdict === "parent"),
  };
}
/**
 * Whether a deleted item belongs to a change whose new text is gone (discarded, deleted or typed
 * over), so restoring it would put the old text next to what the writer has now. A deleted item
 * in no change replaced nothing and always comes back. A receipt written before the changes were
 * recorded is paired from the document as it stands: that can't tell an old backspace from text
 * the writer deleted after the write, so it is the one place the doubling can still happen.
 */
function replacedGone(index: Lineage, part: InversePart): (deleted: Key) => boolean {
  const { inserted, deleted, replaced } = part.effect;
  if (!inserted.length || !deleted.length) return () => false;
  const changes =
    replaced ?? pairChanges(index.doc, part.frontier, part.effect, (k) => index.root(k));
  const changeOf = new Map<Key, EditChange>();
  for (const change of changes) for (const k of clocks(change.deleted)) changeOf.set(k, change);
  const gone = new Map<EditChange, boolean>();
  return (k) => {
    const change = changeOf.get(k);
    if (!change) return false;
    let known = gone.get(change);
    if (known === undefined) {
      known = !clocks(change.inserted).some((n) => index.isVisible(index.effective(n)));
      gone.set(change, known);
    }
    return known;
  };
}
/**
 * Pairs the replaces of a write from the item structure: an inserted run takes the place of the
 * deleted run its `origin` or `rightOrigin` reaches, and deleted siblings are one run. A deleted
 * item of the part's text that existed before the write is not a boundary, whenever it was
 * deleted, since every backspace leaves one. Called at the write, "deleted" is exact; called later
 * on an old receipt, it also counts text the writer deleted since. Only text counts as
 * replacement: attributes, containers and formats come and go with the text they belong to. A
 * deleted run with no inserted text beside it is not a change. `root` maps an item to its
 * restoration lineage, so a change still pairs after Undo and Redo gave its items new clocks.
 * Every step is memoized so the work is linear in the part's items.
 */
function pairChanges(
  doc: Y.Doc,
  frontier: EditFrontier,
  effect: EditEffect,
  root: (k: Key) => Key,
): EditChange[] {
  const inserted = new Set(clocks(effect.inserted)),
    deleted = new Set(clocks(effect.deleted));
  const itemAt = (k: Key) => find(doc, k);
  const stepBack = (k: Key, item: Y.Item): Key | undefined => {
    const id = parse(k);
    if (id.clock > item.id.clock) return key({ client: id.client, clock: id.clock - 1 });
    return undefined;
  };
  const originOf = (k: Key): Key | undefined => {
    const item = itemAt(k);
    return item && (stepBack(k, item) ?? (item.origin ? key(item.origin) : undefined));
  };
  const leftOf = (k: Key): Key | undefined => {
    const item = itemAt(k);
    return item && (stepBack(k, item) ?? (item.left ? key(item.left.lastId) : undefined));
  };
  const rightOf = (k: Key): Key | undefined => {
    const item = itemAt(k),
      id = parse(k);
    if (!item) return undefined;
    if (id.clock < item.id.clock + item.length - 1)
      return key({ client: id.client, clock: id.clock + 1 });
    return item.right ? key(item.right.id) : undefined;
  };
  const rightOriginOf = (k: Key): Key | undefined => {
    const item = itemAt(k);
    return item?.rightOrigin ? key(item.rightOrigin) : undefined;
  };
  // Deleted before this write, so the writer's backspaces and earlier edits are not boundaries.
  // Anything newer is: an item the writer deletes after the write still separates two changes.
  const transparent = (k: Key) => {
    const id = parse(k);
    return !!itemAt(k)?.deleted && !deleted.has(k) && id.clock < (frontier[id.client] ?? 0);
  };
  const top = (k: Key, set: ReadonlySet<Key>): Key => {
    const item = itemAt(k);
    let root = k;
    for (const ancestor of item ? ancestorItems(item) : []) {
      if (!set.has(key(ancestor.id))) break;
      root = key(ancestor.id);
    }
    return root;
  };
  /** The first item reached from `from` that `through` doesn't pass. Each key is walked once. */
  const reach = (
    from: Key | undefined,
    next: (k: Key) => Key | undefined,
    through: (k: Key) => boolean,
    seen: Map<Key, Key | undefined>,
  ): Key | undefined => {
    const path: Key[] = [];
    let cur = from,
      found: Key | undefined;
    while (cur) {
      if (seen.has(cur)) {
        found = seen.get(cur);
        break;
      }
      if (!through(cur)) {
        found = cur;
        break;
      }
      path.push(cur);
      cur = next(cur);
    }
    for (const k of path) seen.set(k, found);
    return found;
  };
  // A deleted run is named by the item to its left that it doesn't pass; a run that starts its
  // parent has no such item and is named by the parent.
  const leftBoundary = new Map<Key, Key | undefined>();
  const runOfElement = (element: Key): Key => {
    const found = reach(
      leftOf(element),
      leftOf,
      (k) => deleted.has(k) || transparent(k),
      leftBoundary,
    );
    if (found) return found;
    const parent = itemAt(element)?.parent as Y.AbstractType<unknown> | undefined;
    return `^${parent?._item ? key(parent._item.id) : ""}`;
  };
  // A restored copy keeps its source's lineage root, so a change still pairs after Undo and Redo
  // gave its items new clocks.
  const runOfRoot = new Map<Key, Key>();
  const deletedIn = new Map<Key, Key[]>();
  for (const k of deleted) {
    const run = runOfElement(top(k, deleted));
    runOfRoot.set(root(k), run);
    const members = deletedIn.get(run);
    if (members) members.push(k);
    else deletedIn.set(run, [k]);
  }
  const insertedIn = new Map<Key, Key[]>();
  const originBoundary = new Map<Key, Key | undefined>(),
    rightBoundary = new Map<Key, Key | undefined>();
  for (const k of inserted) {
    const content = itemAt(k)?.content;
    if (!(content instanceof Y.ContentString || content instanceof Y.ContentEmbed)) continue;
    const container = top(k, inserted);
    const sides = [
      reach(
        originOf(container),
        (n) => (inserted.has(n) ? originOf(n) : leftOf(n)),
        (n) => inserted.has(n) || transparent(n),
        originBoundary,
      ),
      reach(rightOriginOf(container), rightOf, transparent, rightBoundary),
    ];
    for (const side of sides) {
      const run = side && runOfRoot.get(root(side));
      if (!run) continue;
      const members = insertedIn.get(run);
      if (members) members.push(k);
      else insertedIn.set(run, [k]);
    }
  }
  return [...insertedIn].map(([run, keys]) => ({
    deleted: ranges(deletedIn.get(run) ?? []),
    inserted: ranges(keys),
  }));
}
const lazy = <T>(compute: () => T) => {
  let value: { v: T } | undefined;
  return () => {
    value ??= { v: compute() };
    return value.v;
  };
};
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
    const undo = planInverse(index, part);
    if (undo.acts) return { part, state: "active", reasons: [] };
    return changed(undo.blocked ? "inaccessible ancestor" : "nothing left to undo");
  } catch (error) {
    return changed(error instanceof Error ? error.message : String(error));
  }
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
}
/** Compute on an owned cold replica. The caller admits/persists the deltas under its lock. */
export function computeInverse(
  doc: Y.Doc,
  history: readonly InversePart[],
  selection: readonly InversePart[],
  action: InverseAction,
): ComputedInverse {
  return computePreparedInverse(doc, history, selection, action);
}

/**
 * `preview` answers which selected edits an Undo would take, without building it. Only a part a later one is classified on is built, since its
 * receipt joins the history that one is judged against; the last is accepted when it classifies
 * active, and nothing is admitted or normalized.
 */
function computePreparedInverse(
  doc: Y.Doc,
  history: readonly InversePart[],
  selection: readonly InversePart[],
  action: InverseAction,
  prepared?: Lineage,
  { preview = false }: { preview?: boolean } = {},
): ComputedInverse {
  if (!action.actionId) throw new Error("Inverse requires an action ID");
  if (!selection.length) return { actionId: action.actionId, edits: [], skipped: [] };
  let scratch: Y.Doc | undefined;
  const copy = () => {
    scratch = new Y.Doc({ gc: false });
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    return scratch;
  };
  if (!preview) copy();
  const local = [...history],
    result: ComputedInverse = { actionId: action.actionId, edits: [], skipped: [] };
  const groups = new Map<string, ComputedInverseEdit>();
  const groupFor = (editId: string) => {
    let edit = groups.get(editId);
    if (!edit) {
      edit = { targetEditId: editId, parts: [] };
      groups.set(editId, edit);
      result.edits.push(edit);
    }
    return edit;
  };
  try {
    for (const [at, part] of selection.entries()) {
      const lineageOn = (view: Y.Doc) =>
        new Lineage(
          view,
          local,
          local.length === history.length ? prepared : undefined,
          undefined,
          true,
        );
      let index = lineageOn(scratch ?? doc);
      const state = classify(index, part);
      if (state.state !== "active") {
        result.skipped.push(state);
        continue;
      }
      if (preview && at === selection.length - 1) {
        groupFor(part.editId);
        continue;
      }
      const working = scratch ?? copy();
      // Hydrating and undoing change the view, so they run on the replica, never on `doc`.
      if (index.doc !== working) index = lineageOn(working);
      index.hydrate();
      const plan = planInverse(index, part);
      const stack = {
        insertions: deleteSet(plan.removing),
        deletions: deleteSet(plan.restoring),
        meta: new Map(),
      };
      const frontier = captureEditFrontier(working),
        snapshot = snapshotRedone(working);
      const client = action.allocateClient(working);
      if (frontier[client] !== undefined) throw new Error("Inverse client is not fresh");
      const before = preview ? undefined : new Y.Doc({ gc: false });
      if (before) Y.applyUpdate(before, Y.encodeStateAsUpdate(working));
      let updates: Uint8Array[];
      try {
        updates = executeUndo(working, ROOT, client, stack, (item) =>
          shouldDeleteUndoItem(item, stack),
        );
      } catch (error) {
        before?.destroy();
        throw error;
      }
      try {
        if (!updates.length) continue;
        const update = Y.mergeUpdates(updates),
          receipt = captureEditParts(working, [
            { update, frontier, replaced: pairEdit(working, { update, frontier }) },
          ])[0];
        receipt.aliases = captureAliases(working, snapshot);
        if (before) admitPreparedInverseReceipt(before, local, [part], receipt, index);
        const targets: EditTarget[] = [{ editId: part.editId, ordinal: part.ordinal }];
        const edit = groupFor(part.editId);
        edit.parts.push({ ...receipt, targets });
        local.push({
          ...receipt,
          targets,
          id: Math.max(0, ...local.map((p) => p.id)) + 1,
          editId: `computed:${result.edits.indexOf(edit)}`,
          ordinal: edit.parts.length - 1,
          kind: "undo",
          actionId: action.actionId,
        });
      } finally {
        before?.destroy();
      }
    }
    if (!preview)
      for (const edit of result.edits) {
        const normalized = captureEditParts(
          scratch as Y.Doc,
          edit.parts.map((p) => ({ ...p, replaced: p.effect.replaced })),
        );
        edit.parts = edit.parts.map((p, i) => ({ ...p, effect: normalized[i].effect }));
      }
    return result;
  } finally {
    scratch?.destroy();
  }
}

/**
 * One `compute` as bytes, for a thread that holds no Y.Doc of the caller's: the live document's
 * update and the history. A Y.Doc rebuilt from an update plans the same inverse as the one it
 * encodes.
 */
export interface InverseJob {
  live: Uint8Array;
  history: readonly InversePart[];
  selection: readonly InversePart[];
  actionId: string;
}
export function runInverseJob(
  job: InverseJob,
  allocateClient: InverseAction["allocateClient"] = allocateDocumentClient,
): ComputedInverse {
  const cold = (update: Uint8Array) => {
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, update);
    return doc;
  };
  const live = cold(job.live);
  try {
    return prepareEditRoots(live, job.history).compute(job.selection, {
      actionId: job.actionId,
      allocateClient,
    });
  } finally {
    live.destroy();
  }
}

/**
 * One immutable-view lineage for host inspection and inverses; discard before mutation. The
 * lineage is built on first use: it costs a string key per restored clock, which a host that
 * plans the inverse on another thread never needs here.
 */
export function prepareEditRoots(doc: Y.Doc, history: readonly InversePart[]): PreparedEditRoots {
  return preparedRoots(
    doc,
    once(() => new Lineage(doc, history)),
  );
}
function once<T>(make: () => T): () => T {
  let made: { value: T } | undefined;
  return () => {
    made ??= { value: make() };
    return made.value;
  };
}
export interface PreparedEditRoots {
  classify(parts: readonly InversePart[]): PartClassification[];
  compute(selection: readonly InversePart[], action: InverseAction): ComputedInverse;
  /**
   * `compute` for a caller that only needs which edits would be taken. Each accepted part but
   * the last carries its receipt; the last is accepted without being built, so its edit may
   * have no parts. Read only which edits come back, not their parts.
   */
  preview(selection: readonly InversePart[], action: InverseAction): ComputedInverse;
  roots(effect: EditEffect): string[];
  inspect(roots: Iterable<string>): { root: string; identity: string | null }[];
}
function preparedRoots(doc: Y.Doc, lineage: () => Lineage): PreparedEditRoots {
  return {
    classify(parts) {
      const index = lineage();
      return parts.map((part) => classify(index, part));
    },
    compute(selection, action) {
      const index = lineage();
      return computePreparedInverse(doc, index.ordered, selection, action, index);
    },
    preview(selection, action) {
      const index = lineage();
      return computePreparedInverse(doc, index.ordered, selection, action, index, {
        preview: true,
      });
    },
    roots(effect: EditEffect): string[] {
      return lineage().rootsFor(effect);
    },
    inspect(roots: Iterable<string>): { root: string; identity: string | null }[] {
      const index = lineage();
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
