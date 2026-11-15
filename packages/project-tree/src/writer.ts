import type * as Y from "yjs";
import { freeName, shownName } from "./names.js";
import {
  type Actor,
  type BlobRef,
  type CreateRecord,
  type DeleteRecord,
  isListRoot,
  isSourceRoot,
  listRoot,
  type MoveRecord,
  newId,
  type PurgeRecord,
  type RenameRecord,
  type RestoreRecord,
  recordsOf,
  type SettleRecord,
  settleLogOf,
  sourceIdOf,
  type TreeRecord,
  type TreeRecordInput,
} from "./record.js";
import { placeIn, type TreeNode, type TreeProjection } from "./replay.js";
import { childrenOf, descendantsOf, nameAmong, rankAmong, rankAt } from "./shape.js";
import { writable } from "./validate.js";
import { inForce, LIVE, listRecords, replayView, type View } from "./view.js";

/**
 * Makes records in one copy of the list, against what that copy's own view shows. The browser
 * writes its own records this way; the server writes Apply, Discard, Undo and an AI tool's
 * records on a copy at the journal's head, and sends the Yjs update the copy emits.
 */
export class TreeWriter {
  /**
   * `known` answers a view from a projection the caller already holds, current with `doc`, or
   * null for a view it does not hold: the browser's session replays once per change, and a
   * writer that replayed again would pay the whole list for each record.
   */
  constructor(
    readonly doc: Y.Doc,
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
    const records = recordsOf(this.doc).length;
    const settles = settleLogOf(this.doc).length;
    const hit = this.replays.get(view.draft);
    if (hit && hit.records === records && hit.settles === settles) return hit.projection;
    const projection = replayView(this.doc, view);
    this.replays.set(view.draft, { records, settles, projection });
    return projection;
  }

  /** Runs `change` as one Yjs transaction, so its records and settlements travel as one update. */
  transact(change: () => void): void {
    this.doc.transact(change, this.origin);
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

  append(record: TreeRecord): void {
    this.transact(() => recordsOf(this.doc).push([record]));
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
    settleLogOf(this.doc).push([{ id: newId(), actor, targets: [...targets], to, ...extra }]);
  }

  /** One create: `createAll` of one. */
  create(view: View, actor: Actor, input: CreateInput): CreateRecord {
    return this.createAll(view, actor, [input])[0] as CreateRecord;
  }

  /**
   * Creates, in order, against one replay of the view: a name is numbered against the shown
   * siblings and the ones this call made before it, a rank is placed among them, and a parent
   * may be a node an earlier input created. A replay per create would cost the whole list each.
   */
  createAll(view: View, actor: Actor, inputs: readonly CreateInput[]): CreateRecord[] {
    const projection = this.view(view);
    const sources = new Map<string, string>();
    const siblings = new Map<string, { name: string; rank: string }[]>();
    const out: CreateRecord[] = [];
    this.transact(() => {
      for (const input of inputs) {
        const source = isSourceRoot(input.parent)
          ? sourceIdOf(input.parent)
          : (sources.get(input.parent) ?? projection.nodes.get(input.parent)?.source);
        if (source === undefined) throw new Error(`create under unknown parent ${input.parent}`);
        let kids = siblings.get(input.parent);
        if (!kids) {
          kids = childrenOf(projection, input.parent).map((node) => ({
            name: node.displayName,
            rank: node.rank,
          }));
          siblings.set(input.parent, kids);
        }
        const name = freeName(
          input.kind,
          shownName(input.kind, input.name, input.kind === "document" ? input.filetype : undefined),
          new Set(kids.map((kid) => kid.name)),
        );
        const at = Math.max(0, Math.min(input.index ?? kids.length, kids.length));
        const rank = rankAmong(
          kids.map((kid) => kid.rank),
          at,
        );
        kids.splice(at, 0, { name, rank });
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

  /** One move: `moveAll` of one. */
  move(
    view: View,
    actor: Actor,
    node: string,
    parent: string,
    index = Number.MAX_SAFE_INTEGER,
  ): MoveRecord {
    return this.moveAll(view, actor, [{ node, parent, index }])[0] as MoveRecord;
  }

  /**
   * Moves, in order, against one replay of the view: a rank is placed among the siblings as the
   * earlier moves left them, and a name taken there is numbered and carried by the move itself,
   * so the number stays when the other node is renamed. Two nodes moved into one folder under
   * one name are numbered in turn.
   */
  moveAll(
    view: View,
    actor: Actor,
    moves: readonly { node: string; parent: string; index?: number }[],
  ): MoveRecord[] {
    const projection = this.view(view);
    const siblings = new Map<string, { id: string; name: string; rank: string }[]>();
    const kidsOf = (parent: string) => {
      let kids = siblings.get(parent);
      if (!kids) {
        kids = childrenOf(projection, parent).map((child) => ({
          id: child.id,
          name: child.displayName,
          rank: child.rank,
        }));
        siblings.set(parent, kids);
      }
      return kids;
    };
    const placed = new Map<string, string>();
    const out: MoveRecord[] = [];
    this.transact(() => {
      for (const { node, parent, index = Number.MAX_SAFE_INTEGER } of moves) {
        const current = projection.nodes.get(node);
        const was = placed.get(node) ?? current?.parent;
        if (was !== undefined) {
          const left = kidsOf(was);
          const at = left.findIndex((kid) => kid.id === node);
          if (at >= 0) left.splice(at, 1);
        }
        const kids = kidsOf(parent);
        const name = current
          ? freeName(current.kind, current.name, new Set(kids.map((kid) => kid.name)))
          : "";
        const at = Math.max(0, Math.min(index, kids.length));
        const rank = rankAmong(
          kids.map((kid) => kid.rank),
          at,
        );
        kids.splice(at, 0, { id: node, name: current ? name : "", rank });
        placed.set(node, parent);
        out.push(
          this.author(view, actor, {
            type: "move",
            node,
            parent,
            rank,
            from: { parent: current?.parent ?? parent, rank: current?.rank ?? "" },
            ...(current && name !== current.name ? { name } : {}),
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
      name: current
        ? nameAmong(
            projection,
            current.parent,
            current.kind,
            shownName(current.kind, name, filetype ?? current.filetype),
            node,
          )
        : name,
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
    const entry = inForce(this.doc, view, deleteId);
    if (entry === "unknown" || entry?.type !== "delete") return "unknown";
    return this.author(
      view,
      actor,
      { type: "restore", node: entry.node },
      { undoes: entry.carries ?? entry.id },
    ) as RestoreRecord;
  }
}

/** What a create asks for: the name is numbered and the rank placed by the writer. */
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

/** One side of a move between two lists: the writer on that list's copy, and the list's id. */
export type ListEnd = { writer: TreeWriter; list: string };

/** The records of one move between lists, root first and parents before what they hold. */
export type Crossing = { left: MoveRecord[]; entered: CreateRecord[] };

/**
 * A move between two lists (a project's and the account's `user://`) of `node` and what stands
 * below it, as the records the server appends in one transaction: for each node, top-down, a
 * `move` in the list it leaves whose parent names the other list, and a `create` with the same id
 * in the list it enters. The root goes under `into.parent` (at `into.rank`, else `into.index`)
 * under `into.name` or its own, numbered among what is shown there; each node below keeps its
 * parent, rank and shown name, so order and empty folders come with it. A root in Trash crosses
 * live (rule 9); what is in Trash below it by a delete of its own stays in that list's Trash
 * (rule 14).
 */
export function moveBetweenLists(
  out: ListEnd,
  into: CrossingInto,
  actor: Actor,
  node: string,
): Crossing {
  return cross(out, into, actor, node, []);
}

type CrossingInto = ListEnd & {
  parent: string;
  index?: number;
  rank?: string;
  name?: string;
  filetype?: string;
};

/**
 * `moveBetweenLists`, taking back the crossing whose records are `reverses` (none for a new one):
 * each node's pair is marked `undoes` the pair it takes back there.
 */
function cross(
  out: ListEnd,
  into: CrossingInto,
  actor: Actor,
  node: string,
  reverses: readonly string[],
): Crossing {
  const leaving = out.writer.view(LIVE);
  const was = leaving.nodes.get(node);
  if (!was || was.purged) throw new Error(`${node} is not a node that can leave its list`);
  const arrives = into.writer.view(LIVE);
  const source = isSourceRoot(into.parent)
    ? sourceIdOf(into.parent)
    : arrives.nodes.get(into.parent)?.source;
  if (source === undefined) throw new Error(`move into unknown parent ${into.parent}`);

  const nodes = [was, ...standingBelow(leaving, node)];
  const ids = new Set(reverses);
  const marks = (writer: TreeWriter) =>
    new Map(
      ids.size === 0
        ? []
        : listRecords(writer.doc).flatMap((record) =>
            ids.has(record.id) ? [[record.node, record.carries ?? record.id] as const] : [],
          ),
    );
  // The pair taken back: its create in the list the node is in now, its move in the one it returns to.
  const created = marks(out.writer);
  const moved = marks(into.writer);
  const crossing: Crossing = { left: [], entered: [] };
  for (const each of nodes) {
    const root = each.id === node;
    const undoes = (by: ReadonlyMap<string, string>) => {
      const id = by.get(each.id);
      return id === undefined ? {} : { undoes: id };
    };
    crossing.left.push(
      out.writer.prepare(
        LIVE,
        actor,
        {
          type: "move",
          node: each.id,
          parent: listRoot(into.list),
          rank: each.rank,
          from: { parent: each.parent, rank: each.rank },
        },
        undoes(created),
      ) as MoveRecord,
    );
    const filetype = root ? (into.filetype ?? each.filetype) : each.filetype;
    crossing.entered.push(
      into.writer.prepare(
        LIVE,
        actor,
        {
          type: "create",
          node: each.id,
          kind: each.kind,
          name: root
            ? nameAmong(arrives, into.parent, each.kind, into.name ?? each.name)
            : each.displayName,
          parent: root ? into.parent : each.parent,
          source,
          rank: root
            ? (into.rank ?? rankAt(arrives, into.parent, into.index ?? Number.MAX_SAFE_INTEGER))
            : each.rank,
          ...(filetype ? { filetype } : {}),
          ...(each.provisional ? { provisional: true as const } : {}),
          ...(each.aliases ? { aliases: each.aliases } : {}),
          ...(each.hasProperties ? { hasProperties: true as const } : {}),
          ...(each.blob ? { blob: each.blob } : {}),
        },
        undoes(moved),
      ) as CreateRecord,
    );
  }
  // All are built before any is stored, so a move is never left half made.
  out.writer.transact(() => recordsOf(out.writer.doc).push(crossing.left));
  into.writer.transact(() => recordsOf(into.writer.doc).push(crossing.entered));
  return crossing;
}

/**
 * The nodes below `node` that cross with it, parents first in display order: everything except
 * what a delete of a node below it holds in Trash (a delete of `node` or above it is lifted by the
 * move, rule 9), and nothing purged. A deleted folder something crossing keeps standing crosses.
 */
function standingBelow(projection: TreeProjection, node: string): TreeNode[] {
  const below = new Set(descendantsOf(projection, node));
  const held = new Set<string>();
  for (const entry of projection.trash)
    if (below.has(entry.node)) for (const id of [entry.node, ...entry.cascade]) held.add(id);
  const stands = new Map<string, boolean>();
  const standing = (id: string): boolean => {
    let known = stands.get(id);
    if (known === undefined) {
      const kids = projection.children.get(id) ?? [];
      known =
        kids.some((kid) => standing(kid.id)) ||
        (!held.has(id) && projection.nodes.get(id)?.purged !== true);
      stands.set(id, known);
    }
    return known;
  };
  const out: TreeNode[] = [];
  const walk = (parent: string) => {
    for (const kid of projection.children.get(parent) ?? [])
      if (standing(kid.id)) {
        out.push(kid);
        walk(kid.id);
      }
  };
  walk(node);
  return out;
}

/**
 * The Undo of a move between lists, or the Redo of that Undo: the same move the other way, of the
 * root it moved, by id, back to the parent and rank its leave came from (`into.parent` when that
 * folder is no longer there) under the name it left with, unless renamed since. What is below it
 * now goes with it as in any crossing, so a node renamed since keeps its name, one added since
 * comes along, one moved out since stays out and one deleted since stays in that Trash; a node
 * that crossed out of Trash goes back into it (rule 14). `records` are the crossing's own. The
 * root deleted or moved since answers `changed_since`, as an Undo in one list does.
 */
export function moveBackBetweenLists(
  out: ListEnd,
  into: ListEnd & { parent: string; name?: string },
  actor: Actor,
  node: string,
  records: readonly string[],
): Crossing | "changed_since" | "unknown" {
  const ids = new Set(records);
  const leave = listRecords(into.writer.doc).find(
    (record): record is MoveRecord =>
      ids.has(record.id) &&
      record.type === "move" &&
      record.node === node &&
      isListRoot(record.parent),
  );
  const here = out.writer.view(LIVE);
  const now = placeIn(here.nodes, node);
  if (!leave || !now) return "unknown";
  const since = here.sinceEntry.get(node);
  if (deletedSince(out.writer, here, node, ids) || since?.place) return "changed_since";
  const there = into.writer.view(LIVE);
  const back =
    isSourceRoot(leave.from.parent) || placeIn(there.nodes, leave.from.parent)?.kind === "folder";
  const { name, ...end } = into;
  return cross(
    out,
    {
      ...end,
      parent: back ? leave.from.parent : into.parent,
      ...(back ? { rank: leave.from.rank } : {}),
      ...(name !== undefined && !since?.label ? { name } : {}),
    },
    actor,
    node,
    records,
  );
}

/**
 * Whether a delete made after the crossing (`records`) entered this list holds `node` in Trash.
 * The deletes it left Trash with come back with the Undo's create (rule 14): the Redo of that
 * Undo takes them with it, as the crossing did.
 */
function deletedSince(
  writer: TreeWriter,
  here: TreeProjection,
  node: string,
  records: ReadonlySet<string>,
): boolean {
  if (!here.nodes.get(node)?.trashed) return false;
  const order = listRecords(writer.doc);
  const entered = order.findIndex(
    (record) => records.has(record.id) && record.type === "create" && record.node === node,
  );
  const at = (id: string) => order.findIndex((record) => record.id === id);
  return here.trash.some(
    (entry) => (entry.node === node || entry.cascade.includes(node)) && at(entry.id) > entered,
  );
}
