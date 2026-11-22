import type { LoroDoc } from "loro-crdt";
import { compareOrder } from "./order-key.js";
import {
  type Attrs,
  type BlockId,
  overrideMap,
  type ShapeSchema,
  STRUCTURE_MAPS,
  type StructureMap,
} from "./shape.js";

type MapValues = Readonly<Record<string, unknown>>;

/**
 * One read of a structure doc (design §1): the effective value of every key (a fork's override
 * over Live's base), parents with cycles broken, and which blocks show. Built once per read, so
 * a reader pays one pass over the maps rather than a WASM call per key; a write must not use it
 * after it changes the doc.
 *
 * A block shows when its `order` is set, its parent is the document or a shown block, and, for a
 * required container that cannot be filled (a table, a row), it has a shown child it accepts. A
 * cycle (concurrent moves of a cell and a `jsx_container`) reads with its smallest id as a child
 * of the document, on every peer alike.
 */
export class StructureView {
  readonly draft: boolean;
  private readonly base: Record<StructureMap, MapValues>;
  private readonly overrides: Record<StructureMap, MapValues> | null;
  private readonly attrIndex = new Map<BlockId, Record<string, unknown>>();
  private readonly parentOf = new Map<BlockId, BlockId | null | undefined>();
  private readonly childrenOf = new Map<BlockId | null, BlockId[]>();
  readonly shown = new Set<BlockId>();
  /** Every block id the structure names, shown or not. */
  readonly ids: readonly BlockId[];

  constructor(doc: LoroDoc, draft: boolean, shape: ShapeSchema) {
    this.draft = draft;
    const read = (name: string) => doc.getMap(name).toJSON() as MapValues;
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

  order(id: BlockId): string | null | undefined {
    const order = this.value("order", id);
    return typeof order === "string" ? order : order === null ? null : undefined;
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

  private computeShown(shape: ShapeSchema) {
    const memo = new Map<BlockId, boolean>();
    const visit = (id: BlockId): boolean => {
      const known = memo.get(id);
      if (known !== undefined) return known;
      memo.set(id, false);
      const parent = this.parentOf.get(id);
      const node = this.node(id);
      const shows =
        typeof this.order(id) === "string" &&
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
      list.sort((a, b) => compareOrder(this.order(a) as string, a, this.order(b) as string, b));
  }
}
