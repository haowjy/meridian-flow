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
  /** The copy of this block's text a join put in another block, by character id. */
  moved?: [BlockId, [PeerId, number, number][]];
}

/**
 * Whether an `order` value is a key, so the block is in place. Anything else is a removal: a
 * record, or an older build's `null`. A key is base-62 and never starts with `{`, so no read
 * parses a record to tell.
 */
export function isOrderKey(value: unknown): value is string {
  return typeof value === "string" && !value.startsWith("{");
}

type StoredRemoval = {
  at?: unknown;
  seen?: Record<DocKey, Record<PeerId, number>>;
  moved?: [unknown, unknown][];
};

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
    ...(Array.isArray(parsed.moved) &&
    typeof parsed.moved[0] === "string" &&
    Array.isArray(parsed.moved[1])
      ? {
          moved: [
            parsed.moved[0],
            parsed.moved[1].flatMap((run) =>
              Array.isArray(run) &&
              typeof run[0] === "string" &&
              typeof run[1] === "number" &&
              typeof run[2] === "number"
                ? [[run[0], run[1], run[2]] as [PeerId, number, number]]
                : [],
            ),
          ] as [BlockId, [PeerId, number, number][]],
        }
      : {}),
  };
}

export const encodeRemoval = ({ at, seen, moved }: Removal): string =>
  JSON.stringify({
    at,
    seen: Object.fromEntries([...seen].map(([key, version]) => [key, Object.fromEntries(version)])),
    ...(moved ? { moved } : {}),
  });

/**
 * What the show rule reads of a structure, for the blocks in its scope: whether a block has a place
 * in the order (a key, or a kept block's record), its parent as stored (null: the document;
 * undefined: none) and its node. A block outside the scope is read as it already reads (`outside`).
 */
export interface ShowInput {
  placed(id: BlockId): boolean;
  parent(id: BlockId): BlockId | null | undefined;
  node(id: BlockId): string | undefined;
  outside?: {
    shows(id: BlockId): boolean;
    /** The shown blocks outside the scope under `id`. */
    children(id: BlockId): readonly BlockId[];
  };
}

/**
 * The one rule for which blocks show (design §1), over the blocks in `scope`: `StructureView` runs
 * it over every block, and an Undo's test (`take-back.ts`) over the blocks its run would change,
 * with the run's writes laid over the structure. A cycle (concurrent moves of a cell and a
 * `jsx_container`) reads with its smallest id as a child of the document, on every peer alike. A
 * block shows when it has a place in the order, its node is known, and its parent is the document
 * or a shown block; then a required container that cannot be filled (a table, a row) with no shown
 * child it accepts goes, which may empty its own parent, until nothing changes. No text doc decides
 * it. Returns the parents as read (the cycle rule applied) and the blocks of `scope` that show.
 */
export function showRule(
  shape: ShapeSchema,
  scope: readonly BlockId[],
  input: ShowInput,
): { parents: Map<BlockId, BlockId | null | undefined>; shown: Set<BlockId> } {
  const inScope = new Set(scope);
  const parents = new Map<BlockId, BlockId | null | undefined>();
  for (const id of scope) {
    const parent = input.parent(id);
    parents.set(id, typeof parent === "string" ? parent : parent === null ? null : undefined);
  }
  for (const id of scope) {
    const seen = new Map<BlockId, number>();
    const path: BlockId[] = [];
    let at: BlockId | null | undefined = id;
    while (typeof at === "string" && inScope.has(at)) {
      const index = seen.get(at);
      if (index !== undefined) {
        parents.set(path.slice(index).sort()[0], null);
        break;
      }
      seen.set(at, path.length);
      path.push(at);
      at = parents.get(at);
    }
  }
  const outsideShows = (id: BlockId) => input.outside?.shows(id) ?? false;
  const memo = new Map<BlockId, boolean>();
  const visit = (id: BlockId): boolean => {
    if (!inScope.has(id)) return outsideShows(id);
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, false);
    const parent = parents.get(id);
    const node = input.node(id);
    const shows =
      input.placed(id) &&
      node !== undefined &&
      shape.node(node) !== undefined &&
      (parent === null || (typeof parent === "string" && visit(parent)));
    memo.set(id, shows);
    return shows;
  };
  const shown = new Set(scope.filter(visit));
  const below = new Map<BlockId, BlockId[]>();
  for (const id of shown) {
    const parent = parents.get(id);
    if (typeof parent !== "string") continue;
    const list = below.get(parent);
    if (list) list.push(id);
    else below.set(parent, [id]);
  }
  const shows = (id: BlockId) => (inScope.has(id) ? shown.has(id) : outsideShows(id));
  for (let changed = true; changed; ) {
    changed = false;
    for (const id of shown) {
      const parent = parents.get(id);
      const rule = shape.node(input.node(id) as string);
      const orphan = typeof parent === "string" && !shows(parent);
      const empty =
        rule?.required === true &&
        !rule.fillable &&
        ![...(below.get(id) ?? []), ...(input.outside?.children(id) ?? [])].some(
          (child) => shows(child) && rule.accepts(input.node(child) as string),
        );
      if (orphan || empty) {
        shown.delete(id);
        changed = true;
      }
    }
  }
  return { parents, shown };
}

/**
 * One read of a structure doc (design §1): the effective value of every key (a fork's override
 * over Live's base), parents with cycles broken, and which blocks show (`showRule`). Built once
 * per read, so a reader pays one pass over the maps rather than a WASM call per key; a write must
 * not use it after it changes the doc. `kept` names removed blocks to read as set at their
 * record's key though they are removed: the editor's caret rule (design §1).
 */
export class StructureView {
  readonly draft: boolean;
  private readonly base: Record<StructureMap, MapValues>;
  private readonly overrides: Record<StructureMap, MapValues> | null;
  private readonly attrIndex = new Map<BlockId, Record<string, unknown>>();
  private readonly parentOf: ReadonlyMap<BlockId, BlockId | null | undefined>;
  private readonly childrenOf = new Map<BlockId | null, BlockId[]>();
  private readonly orders = new Map<BlockId, string>();
  private below: Map<BlockId, BlockId[]> | undefined;
  readonly shown: ReadonlySet<BlockId>;
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
    this.computeOrders();
    const { parents, shown } = showRule(shape, this.ids, {
      placed: (id) => this.orders.has(id),
      parent: (id) => this.value("parent", id) as BlockId | null | undefined,
      node: (id) => this.node(id),
    });
    this.parentOf = parents;
    this.shown = shown;
    for (const id of shown) {
      const parent = parents.get(id) as BlockId | null;
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
}
