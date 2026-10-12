// Forward inverse receipts, cold lineage tracing, classification and admission.
import * as Y from "yjs";
import {
  allItems,
  ancestorItems,
  changedRedone,
  executeUndo,
  findItem,
  hydrateRedone,
  itemIsInFragment,
  itemIsVisible,
  snapshotRedone,
} from "../yjs-mutation.js";
import { shouldDeleteUndoItem } from "./delete-filter.js";

export interface EditRange {
  client: number;
  clock: number;
  len: number;
}
export interface EditEffect {
  inserted: EditRange[];
  deleted: EditRange[];
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
export type EditKind = "write" | "undo" | "redo" | "revert" | "rollback";
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
export type PartState = "active" | "undone" | "rolled_back" | "changed" | "excluded";
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
const find = (doc: Y.Doc, k: Key) => findItem(doc, parse(k)) ?? undefined;
const inFragment = (doc: Y.Doc, item: Y.Item) => itemIsInFragment(doc, item, ROOT);
function rawEffect(update: Uint8Array): EditEffect {
  const decoded = Y.decodeUpdate(update);
  return {
    inserted: ranges(
      decoded.structs
        .filter((s): s is Y.Item => s instanceof Y.Item)
        .flatMap((s) => clocks([{ client: s.id.client, clock: s.id.clock, len: s.length }])),
    ),
    deleted: [...decoded.ds.clients].flatMap(([client, rs]) =>
      rs.map((r) => ({ client, clock: r.clock, len: r.len })),
    ),
  };
}
/** Capture before mutation, on the locked authoring document. Missing frontiers never default. */
export function captureEditFrontier(doc: Y.Doc): EditFrontier {
  return Object.fromEntries(Y.decodeStateVector(Y.encodeStateVector(doc)));
}
/** Normalize the whole write together, excluding cross-part transients and non-prose roots. */
export function captureEditParts(
  doc: Y.Doc,
  receipts: readonly { update: Uint8Array; frontier: EditFrontier }[],
): CapturedPart[] {
  const raw = receipts.map((r) => rawEffect(r.update));
  const inserted = new Set(raw.flatMap((e) => clocks(e.inserted))),
    deleted = new Set(raw.flatMap((e) => clocks(e.deleted)));
  const transient = new Set([...inserted].filter((k) => deleted.has(k)));
  const keep = (k: Key) => {
    const item = find(doc, k);
    return !transient.has(k) && !!item && inFragment(doc, item);
  };
  return receipts.map((receipt, i) => {
    if (!receipt.frontier) throw new Error("Missing edit frontier");
    return {
      update: receipt.update,
      frontier: receipt.frontier,
      effect: {
        inserted: ranges(clocks(raw[i].inserted).filter(keep)),
        deleted: ranges(clocks(raw[i].deleted).filter(keep)),
      },
      aliases: [],
    };
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

function classify(index: Lineage, part: InversePart): PartClassification {
  const changed = (reason: string): PartClassification => ({
    part,
    state: "changed",
    reasons: [reason],
  });
  if (!part.frontier) return changed("missing frontier");
  const ins = clocks(part.effect.inserted),
    del = clocks(part.effect.deleted),
    originals = [...ins, ...del];
  if (!originals.length) return { part, state: "excluded", reasons: [] };
  try {
    const members = new Set(originals.flatMap((k) => index.descendants(index.root(k))));
    const effective = originals.map((k) => index.effective(k));
    for (const k of effective) {
      const item = find(index.doc, k);
      for (const ancestorItem of item ? ancestorItems(item) : []) {
        const ancestor = key(ancestorItem.id);
        if (!index.isVisible(index.effective(ancestor)) && !members.has(ancestor))
          return changed("inaccessible ancestor");
      }
    }
    for (const item of allItems(index.doc)) {
      if (!inFragment(index.doc, item) || !index.isVisible(key(item.id))) continue;
      const refs = [item.origin, item.rightOrigin, ancestorItems(item)[0]?.id ?? null]
        .filter((id): id is Y.ID => !!id)
        .map(key);
      if (!refs.some((k) => members.has(k))) continue;
      for (let n = 0; n < item.length; n++) {
        const k = key({ client: item.id.client, clock: item.id.clock + n });
        if (members.has(k)) continue;
        const root = parse(index.root(k));
        if (root.clock >= (part.frontier[root.client] ?? 0)) return changed("later dependency");
      }
    }
    const isVisible = (k: Key) => index.isVisible(index.effective(k));
    const authorized = (k: Key) => {
      const owner = index.owners.get(index.effective(k));
      return !!owner && (owner.kind !== "write" || owner.editId === part.editId);
    };
    const active =
      ins.every(isVisible) &&
      del.every((k) => !!find(index.doc, index.effective(k)) && !isVisible(k) && authorized(k));
    const undone =
      ins.every((k) => !isVisible(k) && authorized(k)) &&
      del.every((k) => isVisible(k) && index.restored(k));
    if (active) return { part, state: "active", reasons: [] };
    if (undone) {
      // Only rollback of this selected part is terminal. Rolling back a later
      // inverse restores this part's previous state, not its authorship lifetime.
      const terminal = index.ordered.some(
        (p) =>
          p.kind === "rollback" &&
          p.targets.some(
            (target) => target.editId === part.editId && target.ordinal === part.ordinal,
          ),
      );
      return { part, state: terminal ? "rolled_back" : "undone", reasons: [] };
    }
    return changed("items changed since");
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
/** Compute on an owned cold replica. The caller admits/persists the deltas under its lock. */
export function computeInverse(
  doc: Y.Doc,
  history: readonly InversePart[],
  selection: readonly InverseSelection[],
  action: { actionId: string; allocateClient: (doc: Y.Doc) => number },
): ComputedInverse {
  return computePreparedInverse(doc, history, selection, action);
}

function computePreparedInverse(
  doc: Y.Doc,
  history: readonly InversePart[],
  selection: readonly InverseSelection[],
  action: { actionId: string; allocateClient: (doc: Y.Doc) => number },
  prepared?: Lineage,
): ComputedInverse {
  if (!action.actionId) throw new Error("Inverse requires an action ID");
  if (!selection.length) return { actionId: action.actionId, edits: [], skipped: [] };
  const scratch = new Y.Doc({ gc: false });
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
    for (const { part, direction } of selection) {
      const index = new Lineage(
          scratch,
          local,
          local.length === history.length ? prepared : undefined,
          undefined,
          true,
        ),
        state = classify(index, part);
      if (state.state !== (direction === "invert" ? "active" : "undone")) {
        result.skipped.push(state);
        continue;
      }
      index.hydrate();
      const inserted = clocks(
        direction === "invert" ? part.effect.inserted : part.effect.deleted,
      ).map((k) => index.effective(k));
      const deleted = clocks(
        direction === "invert" ? part.effect.deleted : part.effect.inserted,
      ).map((k) => index.effective(k));
      const stack = {
        insertions: deleteSet(inserted),
        deletions: deleteSet(deleted),
        meta: new Map(),
      };
      const frontier = captureEditFrontier(scratch),
        snapshot = snapshotRedone(scratch);
      const client = action.allocateClient(scratch);
      if (frontier[client] !== undefined) throw new Error("Inverse client is not fresh");
      const before = new Y.Doc({ gc: false });
      Y.applyUpdate(before, Y.encodeStateAsUpdate(scratch));
      let updates: Uint8Array[];
      try {
        updates = executeUndo(scratch, ROOT, client, stack, (item) =>
          shouldDeleteUndoItem(item, stack),
        );
      } catch (error) {
        before.destroy();
        throw error;
      }
      try {
        if (!updates.length) continue;
        const update = Y.mergeUpdates(updates),
          receipt = captureEditParts(scratch, [{ update, frontier }])[0];
        receipt.aliases = captureAliases(scratch, snapshot);
        admitPreparedInverseReceipt(before, local, [part], receipt, index);
        const targets: EditTarget[] = [{ editId: part.editId, ordinal: part.ordinal, direction }];
        let edit = groups.get(part.editId);
        if (!edit) {
          edit = { targetEditId: part.editId, parts: [] };
          groups.set(part.editId, edit);
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
      } finally {
        before.destroy();
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

/** One immutable-view lineage for host holds; discard it before mutating that view. */
export function prepareEditRoots(doc: Y.Doc, history: readonly InversePart[]): PreparedEditRoots {
  return preparedRoots(new Lineage(doc, history));
}
export interface PreparedEditRoots {
  forView(doc: Y.Doc): PreparedEditRoots;
  compute(
    selection: readonly InverseSelection[],
    action: { actionId: string; allocateClient: (doc: Y.Doc) => number },
  ): ComputedInverse;
  roots(effect: EditEffect): string[];
  inspect(roots: Iterable<string>): { root: string; identity: string | null }[];
}
function preparedRoots(index: Lineage): PreparedEditRoots {
  const { doc, ordered: history } = index;
  return {
    forView(view) {
      return preparedRoots(new Lineage(view, history, index));
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
