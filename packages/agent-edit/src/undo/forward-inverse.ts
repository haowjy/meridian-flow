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
  const [client, clock] = k.split(":").map(Number);
  return Y.createID(client, clock);
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
const visible = (doc: Y.Doc, k: Key) => itemIsVisible(doc, parse(k));
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
  constructor(
    readonly doc: Y.Doc,
    history: readonly InversePart[],
  ) {
    this.ordered = [...history].sort((a, b) => a.id - b.id);
    for (const p of this.ordered) {
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
          links.push(target);
          this.forward.set(source, links);
        }
    }
  }
  descendants(k: Key): Key[] {
    const out: Key[] = [],
      seen = new Set<Key>();
    const walk = (source: Key) => {
      if (seen.has(source)) throw new Error("Cyclic restoration lineage");
      seen.add(source);
      out.push(source);
      for (const target of this.forward.get(source) ?? []) if (!out.includes(target)) walk(target);
    };
    walk(k);
    return out;
  }
  root(k: Key): Key {
    const seen = new Set<Key>();
    while (this.backward.has(k)) {
      if (seen.has(k)) throw new Error("Cyclic restoration lineage");
      seen.add(k);
      k = this.backward.get(k) ?? k;
    }
    return k;
  }
  effective(k: Key): Key {
    const descendants = this.descendants(this.root(k));
    const shown = descendants.filter((k) => visible(this.doc, k));
    if (shown.length > 1) throw new Error("Multiple visible restorations of one root");
    if (shown.length) return shown[0];
    return [...descendants].reverse().find((k) => !!find(this.doc, k)) ?? k;
  }
  related(owner: InversePart | undefined, target: InversePart, seen = new Set<number>()): boolean {
    if (!owner || seen.has(owner.id)) return false;
    if (owner.editId === target.editId && owner.ordinal === target.ordinal) return true;
    if (owner.kind === "write") return false;
    seen.add(owner.id);
    return owner.targets.some((t) => {
      if (t.editId === target.editId && t.ordinal === target.ordinal) return true;
      return this.related(
        this.ordered.find((p) => p.editId === t.editId && p.ordinal === t.ordinal),
        target,
        seen,
      );
    });
  }
  restored(k: Key): boolean {
    return this.descendants(this.root(k)).some((source) => this.inverseRestorations.has(source));
  }
  hydrate(): void {
    const pairs: { source: Y.ID; target: Y.ID }[] = [];
    for (const source of this.forward.keys()) {
      const candidates = this.descendants(source)
        .slice(1)
        .filter((k) => !!find(this.doc, k));
      const target = candidates.find((k) => visible(this.doc, k)) ?? candidates.at(-1);
      if (target && find(this.doc, source))
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
        if (!visible(index.doc, index.effective(ancestor)) && !members.has(ancestor))
          return changed("inaccessible ancestor");
      }
    }
    for (const item of allItems(index.doc)) {
      if (!inFragment(index.doc, item) || !visible(index.doc, key(item.id))) continue;
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
    const isVisible = (k: Key) => visible(index.doc, index.effective(k));
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
      const last = [...index.ordered]
        .reverse()
        .find((p) => p.kind !== "write" && index.related(p, part));
      return { part, state: last?.kind === "rollback" ? "rolled_back" : "undone", reasons: [] };
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
  const index = new Lineage(doc, history);
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
    const merged = new Lineage(after, [
      ...history,
      {
        ...receipt,
        id: Math.max(0, ...history.map((p) => p.id)) + 1,
        editId: "admission",
        ordinal: 0,
        kind: "undo",
        targets: [],
      },
    ]);
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
  if (!action.actionId) throw new Error("Inverse requires an action ID");
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
      const index = new Lineage(scratch, local),
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
        admitInverseReceipt(before, local, [part], receipt);
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

/** Visible identity by restoration root, used by host-owned cross-view holds. */
export function inspectEditRoots(
  doc: Y.Doc,
  history: readonly InversePart[],
  effect: EditEffect,
): { root: string; identity: string | null }[] {
  const index = new Lineage(doc, history);
  return [
    ...new Set(clocks([...effect.inserted, ...effect.deleted]).map((k) => index.root(k))),
  ].map((root) => {
    const effective = index.effective(root);
    return { root, identity: visible(doc, effective) ? effective : null };
  });
}
