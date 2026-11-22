import { inMap } from "./handles.js";
import { compareOrder } from "./order-key.js";
import type { PeerId } from "./peer.js";
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
import type { DocVersion } from "./version.js";

const NONE: ReadonlySet<BlockId> = new Set();

type MapValues = Readonly<Record<string, unknown>>;

/**
 * A removed block's `order` (design §1, "Removed blocks"), stored as JSON text: the key the block
 * had, and for every text doc under it (itself included) the version the removal read. A doc
 * with no entry was read empty.
 */
export interface Removal {
  at: string;
  seen: ReadonlyMap<DocKey, DocVersion>;
}

/**
 * Whether an `order` value is a key, so the block is in place. Anything else is a removal: a
 * record, or an older build's `null`. A key is base-62 and never starts with `{`, so no read
 * parses a record to tell.
 */
export function isOrderKey(value: unknown): value is string {
  return typeof value === "string" && !value.startsWith("{");
}

type StoredRemoval = { at?: unknown; seen?: Record<DocKey, Record<PeerId, number>> };

/** The record an `order` value holds, or null: a key, or a removal written without one. */
export function removalOf(value: unknown): Removal | null {
  if (typeof value !== "string" || isOrderKey(value)) return null;
  let parsed: StoredRemoval;
  try {
    parsed = (JSON.parse(value) ?? {}) as StoredRemoval;
  } catch {
    return null;
  }
  const { at, seen } = parsed;
  if (!isOrderKey(at) || seen === null || typeof seen !== "object") return null;
  return {
    at,
    seen: new Map(
      Object.entries(seen).map(([key, version]) => [
        key,
        new Map(Object.entries(version)) as DocVersion,
      ]),
    ),
  };
}

export const encodeRemoval = ({ at, seen }: Removal): string =>
  JSON.stringify({
    at,
    seen: Object.fromEntries([...seen].map(([key, version]) => [key, Object.fromEntries(version)])),
  });

/**
 * One read of a structure doc (design §1): the effective value of every key (a fork's override
 * over Live's base), parents with cycles broken, and which blocks show. Built once per read, so
 * a reader pays one pass over the maps rather than a WASM call per key; a write must not use it
 * after it changes the doc.
 *
 * A block shows when its `order` is a key, its parent is the document or a shown block, and, for a
 * required container that cannot be filled (a table, a row), it has a shown child it accepts; no
 * text doc decides it. `kept` names removed blocks to read as set at their record's key though
 * they are removed: the editor's caret rule (design §1). A cycle (concurrent moves of a cell and
 * a `jsx_container`) reads with its smallest id as a child of the document, on every peer alike.
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
  /** Every block id the structure names, shown or not. */
  readonly ids: readonly BlockId[];

  constructor(
    docs: RoomDocs,
    readonly kept: ReadonlySet<BlockId> = NONE,
  ) {
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
    this.computeOrders();
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

  /** The key a reader sorts by: the stored one, a kept block's old one; null when removed. */
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

  private computeOrders() {
    for (const id of this.ids) {
      const order = this.value("order", id);
      if (isOrderKey(order)) this.orders.set(id, order);
      else if (this.kept.has(id)) {
        const removal = removalOf(order);
        if (removal) this.orders.set(id, removal.at);
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
