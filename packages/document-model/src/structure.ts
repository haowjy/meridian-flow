import type { LoroDoc } from "loro-crdt";
import { inMap, inText, inVersion } from "./handles.js";
import { compareOrder } from "./order-key.js";
import type { RoomDocs } from "./room-docs.js";
import {
  type Attrs,
  type BlockId,
  type DocKey,
  overrideMap,
  type ShapeSchema,
  STRUCTURE_MAPS,
  type StructureMap,
} from "./shape.js";

type MapValues = Readonly<Record<string, unknown>>;

/**
 * A removed block's `order` (design §1, "Removed blocks"): the key it had, and for every text doc
 * under it (itself included) what the removal read: the doc's version as `{ peer: counter }` and
 * a hash of its text. A doc with no entry was read empty.
 */
export interface Removal {
  at: string;
  seen: Readonly<Record<DocKey, TextRead>>;
}

export interface TextRead {
  version: Readonly<Record<string, number>>;
  text: number;
}

function removalOf(value: unknown): Removal | null {
  if (value === null || typeof value !== "object") return null;
  const { at, seen } = value as Partial<Removal>;
  return typeof at === "string" && seen && typeof seen === "object" ? { at, seen } : null;
}

/** What a removal records of a text doc as it reads now. */
export function textRead(doc: LoroDoc): TextRead {
  return {
    version: versionOf(doc),
    text: textHash(textOf(doc)),
  };
}

/**
 * Whether `key`'s text reads differently from what `removal` read. The version is checked first,
 * so a doc nobody edited since costs no read of its text; a Ctrl+Z and Redo that give back the
 * text the removal read leave the block removed.
 */
function editedSince(docs: RoomDocs, key: DocKey, removal: Removal): boolean {
  const doc = docs.textOf(key);
  if (!doc) return false;
  const read = removal.seen[key];
  const version = read?.version ?? {};
  let beyond = false;
  for (const [peer, counter] of Object.entries(versionOf(doc)))
    if (counter > (version[peer] ?? 0)) beyond = true;
  return beyond && textHash(textOf(doc)) !== (read?.text ?? EMPTY_TEXT);
}

/** A doc's oplog version as `{ peer: counter }`. */
function versionOf(doc: LoroDoc): Record<string, number> {
  return inVersion(doc, (vector) => Object.fromEntries(vector.toJSON()));
}

function textOf(doc: LoroDoc): string {
  return inText(doc, (text) => text.toString());
}

/** cyrb53: a 53-bit string hash, the same on every peer. */
function textHash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const EMPTY_TEXT = textHash("");

/**
 * One read of a structure doc (design §1): the effective value of every key (a fork's override
 * over Live's base), parents with cycles broken, and which blocks show. Built once per read, so
 * a reader pays one pass over the maps rather than a WASM call per key; a write must not use it
 * after it changes the doc.
 *
 * A block shows when its `order` is set, its parent is the document or a shown block, and, for a
 * required container that cannot be filled (a table, a row), it has a shown child it accepts. A
 * removed block (`order` a `Removal`) reads as set at its old key while a text doc under it reads
 * differently from what the removal read (`revived`). A cycle (concurrent moves of a cell and a
 * `jsx_container`) reads with its smallest id as a child of the document, on every peer alike.
 */
export class StructureView {
  readonly draft: boolean;
  private readonly base: Record<StructureMap, MapValues>;
  private readonly overrides: Record<StructureMap, MapValues> | null;
  private readonly attrIndex = new Map<BlockId, Record<string, unknown>>();
  private readonly parentOf = new Map<BlockId, BlockId | null | undefined>();
  private readonly childrenOf = new Map<BlockId | null, BlockId[]>();
  private readonly orders = new Map<BlockId, string>();
  private below: Map<BlockId, BlockId[]> | undefined;
  readonly shown = new Set<BlockId>();
  /** Removed blocks that read as set again: text under them changed since their removal read it. */
  readonly revived = new Set<BlockId>();
  /** Every block id the structure names, shown or not. */
  readonly ids: readonly BlockId[];

  constructor(docs: RoomDocs) {
    const { structure: doc, draft, shape } = docs;
    this.draft = draft;
    const read = (name: string) => inMap(doc, name, (map) => map.toJSON() as MapValues);
    this.base = Object.fromEntries(STRUCTURE_MAPS.map((n) => [n, read(n)])) as Record<
      StructureMap,
      MapValues
    >;
    this.overrides = draft
      ? (Object.fromEntries(STRUCTURE_MAPS.map((n) => [n, read(overrideMap(n))])) as Record<
          StructureMap,
          MapValues
        >)
      : null;
    this.ids = [
      ...new Set([...Object.keys(this.base.order), ...Object.keys(this.overrides?.order ?? {})]),
    ];
    for (const key of new Set([
      ...Object.keys(this.base.attrs),
      ...Object.keys(this.overrides?.attrs ?? {}),
    ])) {
      const slash = key.lastIndexOf("/");
      if (slash <= 0) continue;
      const value = this.value("attrs", key);
      if (value === null || value === undefined) continue;
      const id = key.slice(0, slash);
      let attrs = this.attrIndex.get(id);
      if (!attrs) {
        attrs = {};
        this.attrIndex.set(id, attrs);
      }
      attrs[key.slice(slash + 1)] = value;
    }
    this.breakCycles();
    this.computeOrders(docs);
    this.computeShown(shape);
  }

  /** The value a reader sees: a draft's override where it has one, else Live's. */
  value(name: StructureMap, key: string): unknown {
    const override = this.overrides?.[name][key];
    return override === undefined ? this.base[name][key] : override;
  }

  /** Live's value, under any override. */
  baseValue(name: StructureMap, key: string): unknown {
    return this.base[name][key];
  }

  override(name: StructureMap, key: string): unknown {
    return this.overrides?.[name][key];
  }

  overrideKeys(name: StructureMap): string[] {
    return Object.keys(this.overrides?.[name] ?? {});
  }

  node(id: BlockId): string | undefined {
    const node = this.value("node", id);
    return typeof node === "string" ? node : undefined;
  }

  /** The key a reader sorts by: the stored one, a revived block's old one; null when removed. */
  order(id: BlockId): string | null | undefined {
    const order = this.orders.get(id);
    if (order !== undefined) return order;
    return this.value("order", id) === undefined ? undefined : null;
  }

  /** The removal stored for `id`, if its `order` holds one. */
  removal(id: BlockId): Removal | null {
    return removalOf(this.value("order", id));
  }

  /** Every text doc key under `id` (itself included), by the parents as read, shown or not. */
  textKeysUnder(id: BlockId): DocKey[] {
    if (!this.below) {
      const below = new Map<BlockId, BlockId[]>();
      for (const [child, parent] of this.parentOf) {
        if (typeof parent !== "string") continue;
        const list = below.get(parent);
        if (list) list.push(child);
        else below.set(parent, [child]);
      }
      this.below = below;
    }
    const below = this.below;
    const out: DocKey[] = [];
    const walk = (at: BlockId) => {
      out.push(at);
      for (const child of below.get(at) ?? []) walk(child);
    };
    walk(id);
    return out;
  }

  attrs(id: BlockId): Attrs {
    return this.attrIndex.get(id) ?? {};
  }

  /** The parent as read, after the cycle rule: null is the document, undefined a missing key. */
  parent(id: BlockId): BlockId | null | undefined {
    return this.parentOf.get(id);
  }

  /** The shown children of `parent` (null: the document), in order. */
  children(parent: BlockId | null): readonly BlockId[] {
    return this.childrenOf.get(parent) ?? [];
  }

  private breakCycles() {
    const known = new Set(this.ids);
    for (const id of this.ids) {
      const parent = this.value("parent", id);
      this.parentOf.set(
        id,
        typeof parent === "string" ? parent : parent === null ? null : undefined,
      );
    }
    for (const id of this.ids) {
      const seen = new Map<BlockId, number>();
      const path: BlockId[] = [];
      let at: BlockId | null | undefined = id;
      while (typeof at === "string" && known.has(at)) {
        const index = seen.get(at);
        if (index !== undefined) {
          const smallest = path.slice(index).sort()[0];
          this.parentOf.set(smallest, null);
          break;
        }
        seen.set(at, path.length);
        path.push(at);
        at = this.parentOf.get(at);
      }
    }
  }

  /**
   * Every block's key as read. A removed block revives when a text doc now under it (its own, or
   * a block's below it) reads differently from what the removal read: typing that raced the
   * removal. Each doc is checked against every removed block above it, so a container revives
   * with the text typed into it.
   */
  private computeOrders(docs: RoomDocs) {
    const removals = new Map<BlockId, Removal>();
    for (const id of this.ids) {
      const order = this.value("order", id);
      if (typeof order === "string") this.orders.set(id, order);
      else {
        const removal = removalOf(order);
        if (removal) removals.set(id, removal);
      }
    }
    if (removals.size === 0) return;
    for (const key of this.ids) {
      let at: BlockId | null | undefined = key;
      while (typeof at === "string") {
        const removal = removals.get(at);
        if (removal && !this.revived.has(at) && editedSince(docs, key, removal)) {
          this.revived.add(at);
          this.orders.set(at, removal.at);
        }
        at = this.parentOf.get(at);
      }
    }
  }

  private computeShown(shape: ShapeSchema) {
    const memo = new Map<BlockId, boolean>();
    const visit = (id: BlockId): boolean => {
      const known = memo.get(id);
      if (known !== undefined) return known;
      memo.set(id, false);
      const parent = this.parentOf.get(id);
      const node = this.node(id);
      const shows =
        this.orders.has(id) &&
        node !== undefined &&
        shape.node(node) !== undefined &&
        (parent === null || (typeof parent === "string" && visit(parent)));
      memo.set(id, shows);
      return shows;
    };
    for (const id of this.ids) if (visit(id)) this.shown.add(id);
    const below = new Map<BlockId, BlockId[]>();
    for (const id of this.shown) {
      const parent = this.parentOf.get(id);
      if (typeof parent !== "string") continue;
      let list = below.get(parent);
      if (!list) {
        list = [];
        below.set(parent, list);
      }
      list.push(id);
    }
    // A container that needs content it cannot be given hides with nothing to hold; hiding it may
    // empty its own parent, so repeat until nothing changes.
    for (let changed = true; changed; ) {
      changed = false;
      for (const id of this.shown) {
        const parent = this.parentOf.get(id);
        const rule = shape.node(this.node(id) as string);
        const orphan = typeof parent === "string" && !this.shown.has(parent);
        const empty =
          rule?.required === true &&
          !rule.fillable &&
          !(below.get(id) ?? []).some(
            (child) => this.shown.has(child) && rule.accepts(this.node(child) as string),
          );
        if (orphan || empty) {
          this.shown.delete(id);
          changed = true;
        }
      }
    }
    for (const id of this.shown) {
      const parent = this.parentOf.get(id) as BlockId | null;
      let list = this.childrenOf.get(parent);
      if (!list) {
        list = [];
        this.childrenOf.set(parent, list);
      }
      list.push(id);
    }
    for (const list of this.childrenOf.values())
      list.sort((a, b) =>
        compareOrder(this.orders.get(a) as string, a, this.orders.get(b) as string, b),
      );
  }
}
