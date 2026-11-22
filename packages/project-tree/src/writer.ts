import type { ContextSiblingPosition } from "@meridian/contracts/protocol";
import type * as Y from "yjs";
import { listOf, type TreeDoc } from "./list-doc.js";
import { shownName } from "./names.js";
import {
  type Actor,
  type BlobRef,
  type CreateRecord,
  type DeleteRecord,
  isSourceRoot,
  type MoveRecord,
  newId,
  type PurgeRecord,
  type RenameRecord,
  type RestoreRecord,
  type SettleRecord,
  sourceIdOf,
  type TreeRecord,
  type TreeRecordInput,
} from "./record.js";
import type { TreeProjection } from "./replay.js";
import { childrenOf, descendantsOf, rankAmong } from "./shape.js";
import { writable } from "./validate.js";
import { droppedRecords, LIVE, lastOfFamily, replayView, type View } from "./view.js";

/** Where moved nodes land among the parent's children: an index there, or an edge by sibling id. */
export type MovePlace = number | ContextSiblingPosition;

function indexOf(kids: readonly { id: string }[], place: MovePlace): number {
  if (typeof place === "number") return Math.max(0, Math.min(place, kids.length));
  if (!("siblingId" in place)) return place.kind === "start" ? 0 : kids.length;
  const at = kids.findIndex((kid) => kid.id === place.siblingId);
  if (at < 0) return kids.length;
  return place.kind === "before" ? at : at + 1;
}

/**
 * Makes records in one copy of the list, against what that copy's own view shows. The browser
 * writes its own records this way; the server writes Apply, Discard, Undo and an AI tool's
 * records on a copy at the journal's head, and sends the Yjs update the copy emits.
 */
export class TreeWriter<D extends TreeDoc = Y.Doc> {
  /**
   * `known` answers a view from a projection the caller already holds, current with `doc`, or
   * null for a view it does not hold: the browser's session replays once per change, and a
   * writer that replayed again would pay the whole list for each record.
   */
  constructor(
    readonly doc: D,
    private readonly origin: string = "local",
    private readonly known?: (view: View) => TreeProjection | null,
  ) {}

  /** The last replay of each view and the list lengths it replayed: the list only grows. */
  private readonly replays = new Map<
    string | null,
    { records: number; settles: number; projection: TreeProjection }
  >();

  /** The view's tree, replayed once per version of the list however many times it is asked for. */
  view(view: View): TreeProjection {
    const known = this.known?.(view);
    if (known) return known;
    const records = listOf(this.doc).recordCount();
    const settles = listOf(this.doc).settleCount();
    const hit = this.replays.get(view.draft);
    if (hit && hit.records === records && hit.settles === settles) return hit.projection;
    const projection = replayView(this.doc, view);
    this.replays.set(view.draft, { records, settles, projection });
    return projection;
  }

  /** Runs `change` as one transaction, so its records and settlements travel as one update. */
  transact(change: () => void): void {
    listOf(this.doc).transact(change, this.origin);
  }

  /** The record for `input`, read through the reader that will read it back: throws when that would drop it. */
  prepare(
    view: View,
    actor: Actor,
    input: TreeRecordInput,
    extra: Partial<TreeRecord> = {},
  ): TreeRecord {
    return writable({
      ...input,
      id: newId(),
      actor,
      draft: view.draft,
      ...extra,
    } as TreeRecord);
  }

  /** Appends one record. */
  append(record: TreeRecord): void {
    this.transact(() => listOf(this.doc).pushRecords([record]));
  }

  /**
   * Appends records in one transaction. `seen` are the replays of the views with them appended,
   * which the writer then keeps: the next read of each is not another replay of the whole list.
   */
  appendAll(
    records: readonly TreeRecord[],
    seen: ReadonlyArray<{ view: View; projection: TreeProjection }>,
  ): void {
    this.transact(() => listOf(this.doc).pushRecords(records));
    const dropped = droppedRecords(this.doc);
    for (const { view, projection } of seen)
      this.replays.set(view.draft, {
        records: listOf(this.doc).recordCount(),
        settles: listOf(this.doc).settleCount(),
        projection: { ...projection, dropped },
      });
  }

  author(
    view: View,
    actor: Actor,
    input: TreeRecordInput,
    extra: Partial<TreeRecord> = {},
  ): TreeRecord {
    const record = this.prepare(view, actor, input, extra);
    this.append(record);
    return record;
  }

  /** Appends one settlement. Call inside `transact` with what it settles. */
  settle(
    actor: Actor,
    targets: readonly string[],
    to: SettleRecord["to"],
    extra: { reason?: string; command?: string } = {},
  ): void {
    if (targets.length === 0) return;
    listOf(this.doc).pushSettles([{ id: newId(), actor, targets: [...targets], to, ...extra }]);
  }

  /** One create: `createAll` of one. */
  create(view: View, actor: Actor, input: CreateInput): CreateRecord {
    return this.createAll(view, actor, [input])[0] as CreateRecord;
  }

  /**
   * Creates, in order, against one replay of the view: a rank is placed among the shown siblings
   * and the ones this call made before it, and a parent may be a node an earlier input created.
   * A replay per create would cost the whole list each.
   */
  createAll(view: View, actor: Actor, inputs: readonly CreateInput[]): CreateRecord[] {
    const projection = this.view(view);
    const sources = new Map<string, string>();
    const siblings = new Map<string, string[]>();
    const out: CreateRecord[] = [];
    this.transact(() => {
      for (const input of inputs) {
        const source = isSourceRoot(input.parent)
          ? sourceIdOf(input.parent)
          : (sources.get(input.parent) ?? projection.nodes.get(input.parent)?.source);
        if (source === undefined) throw new Error(`create under unknown parent ${input.parent}`);
        let kids = siblings.get(input.parent);
        if (!kids) {
          kids = childrenOf(projection, input.parent).map((node) => node.rank);
          siblings.set(input.parent, kids);
        }
        const name = shownName(
          input.kind,
          input.name,
          input.kind === "document" ? input.filetype : undefined,
        );
        const at = Math.max(0, Math.min(input.index ?? kids.length, kids.length));
        const rank = rankAmong(kids, at);
        kids.splice(at, 0, rank);
        const record = this.author(view, actor, {
          type: "create",
          node: input.node ?? newId(),
          kind: input.kind,
          name,
          parent: input.parent,
          source,
          rank,
          ...(input.kind === "document" ? { filetype: input.filetype } : {}),
          ...(input.provisional ? { provisional: true as const } : {}),
          ...(input.aliases ? { aliases: input.aliases } : {}),
          ...(input.hasProperties ? { hasProperties: true as const } : {}),
          ...(input.kind === "file" && input.blob ? { blob: input.blob } : {}),
        }) as CreateRecord;
        sources.set(record.node, source);
        out.push(record);
      }
    });
    return out;
  }

  /** One move: `moveAll` of one, at `index` among the parent's children without `node`. */
  move(
    view: View,
    actor: Actor,
    node: string,
    parent: string,
    index = Number.MAX_SAFE_INTEGER,
  ): MoveRecord {
    return this.moveAll(view, actor, [node], parent, index)[0] as MoveRecord;
  }

  /**
   * Moves `nodes` into `parent` together, in order, against one replay of the view: the first
   * lands at `place`, each later one right after the one before it. An index counts the parent's
   * children without the node being placed; a sibling `place` names gone from the parent means
   * the end. A name taken there stays taken: twins are made, nothing is numbered. Callers pass
   * distinct nodes, none inside another, and no anchor among them.
   */
  moveAll(
    view: View,
    actor: Actor,
    nodes: readonly string[],
    parent: string,
    place: MovePlace = { kind: "end" },
  ): MoveRecord[] {
    const projection = this.view(view);
    const siblings = new Map<string, { id: string; rank: string }[]>();
    const kidsOf = (folder: string) => {
      let kids = siblings.get(folder);
      if (!kids) {
        kids = childrenOf(projection, folder).map((child) => ({ id: child.id, rank: child.rank }));
        siblings.set(folder, kids);
      }
      return kids;
    };
    const out: MoveRecord[] = [];
    let previous: string | undefined;
    this.transact(() => {
      for (const node of nodes) {
        const current = projection.nodes.get(node);
        if (current) {
          const left = kidsOf(current.parent);
          const at = left.findIndex((kid) => kid.id === node);
          if (at >= 0) left.splice(at, 1);
        }
        const kids = kidsOf(parent);
        const at = indexOf(
          kids,
          previous === undefined ? place : { kind: "after", siblingId: previous },
        );
        const rank = rankAmong(
          kids.map((kid) => kid.rank),
          at,
        );
        kids.splice(at, 0, { id: node, rank });
        previous = node;
        out.push(
          this.author(view, actor, {
            type: "move",
            node,
            parent,
            rank,
            from: { parent: current?.parent ?? parent, rank: current?.rank ?? "" },
          }) as MoveRecord,
        );
      }
    });
    return out;
  }

  rename(view: View, actor: Actor, node: string, name: string, filetype?: string): RenameRecord {
    const projection = this.view(view);
    const current = projection.nodes.get(node);
    return this.author(view, actor, {
      type: "rename",
      node,
      name: current ? shownName(current.kind, name, filetype ?? current.filetype) : name,
      fromName: current?.name ?? "",
      ...(filetype ? { filetype } : {}),
    }) as RenameRecord;
  }

  /** One delete: `deleteAll` of one. */
  delete(view: View, actor: Actor, node: string): DeleteRecord {
    return this.deleteAll(view, actor, [node])[0] as DeleteRecord;
  }

  /**
   * Deletes, against one replay of the view. A node an earlier delete of this call already took
   * with its folder gets no record of its own, and a folder's cascade leaves out what the call
   * deleted before it.
   */
  deleteAll(view: View, actor: Actor, nodes: readonly string[]): DeleteRecord[] {
    const projection = this.view(view);
    const gone = new Set<string>();
    const out: DeleteRecord[] = [];
    this.transact(() => {
      for (const node of nodes) {
        if (gone.has(node)) continue;
        const cascade = descendantsOf(projection, node).filter(
          (id) => !projection.nodes.get(id)?.trashed && !gone.has(id),
        );
        gone.add(node);
        for (const id of cascade) gone.add(id);
        out.push(this.author(view, actor, { type: "delete", node, cascade }) as DeleteRecord);
      }
    });
    return out;
  }

  restore(view: View, actor: Actor, node: string): RestoreRecord {
    return this.author(view, actor, { type: "restore", node }) as RestoreRecord;
  }

  /** Empties one Trash entry: `nodes`, what the delete `entry.id` covers now, are gone for good. */
  purge(actor: Actor, entry: { id: string; node: string }, nodes: readonly string[]): PurgeRecord {
    return this.author(LIVE, actor, {
      type: "purge",
      node: entry.node,
      delete: entry.id,
      nodes: [...nodes],
    }) as PurgeRecord;
  }

  /**
   * Restores one Trash entry: the delete named, and no other delete of the same folder. A
   * folder deleted, brought back for one chapter and deleted again by someone else has two
   * entries, and restoring one must not undo the other.
   */
  restoreEntry(view: View, actor: Actor, deleteId: string): RestoreRecord | "unknown" {
    const entry = lastOfFamily(this.doc, view, deleteId);
    if (entry === "unknown" || entry?.type !== "delete") return "unknown";
    return this.author(
      view,
      actor,
      { type: "restore", node: entry.node },
      { undoes: entry.carries ?? entry.id },
    ) as RestoreRecord;
  }
}

/** What a create asks for: the rank is placed by the writer. */
export type CreateInput = {
  name: string;
  parent: string;
  index?: number;
  node?: string;
  provisional?: true;
  /** Server only: what the node was known as before (an import's reveal). */
  aliases?: CreateRecord["aliases"];
  hasProperties?: true;
} & (
  | { kind: "folder" }
  | { kind: "document"; filetype: string }
  | { kind: "file"; blob?: BlobRef }
);
