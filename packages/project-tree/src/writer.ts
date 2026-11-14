import type * as Y from "yjs";
import { freeName } from "./names.js";
import {
  type Actor,
  type BlobRef,
  type CreateRecord,
  type DeleteRecord,
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
import type { TreeProjection } from "./replay.js";
import { childrenOf, descendantsOf, nameAmong, rankAmong, rankAt } from "./shape.js";
import { writable } from "./validate.js";
import { inForce, LIVE, replayView, type View } from "./view.js";

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

  view(view: View): TreeProjection {
    return this.known?.(view) ?? replayView(this.doc, view);
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
        const name = freeName(input.kind, input.name, new Set(kids.map((kid) => kid.name)));
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
      name: current ? nameAmong(projection, current.parent, current.kind, name, node) : name,
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

  /** Empties one Trash entry: what the delete `entry.id` took is gone for good. */
  purge(actor: Actor, entry: { id: string; node: string }): PurgeRecord {
    return this.author(LIVE, actor, {
      type: "purge",
      node: entry.node,
      delete: entry.id,
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

/**
 * A move between two lists (a project's and the account's `user://`), as the pair the server
 * appends in one transaction: a `move` in the list the node leaves, whose parent names the
 * other list, and a `create` for the same node id in the list it enters, under `parent` there.
 * Moving back is the same pair the other way. A folder stays: what is inside it has no pair.
 */
export function moveBetweenLists(
  out: ListEnd,
  into: ListEnd & { parent: string; index?: number },
  actor: Actor,
  node: string,
): { left: MoveRecord; entered: CreateRecord } {
  const was = out.writer.view(LIVE).nodes.get(node);
  if (!was || was.trashed || was.kind === "folder")
    throw new Error(`${node} is not a document that can leave its list`);
  const arrives = into.writer.view(LIVE);
  const source = isSourceRoot(into.parent)
    ? sourceIdOf(into.parent)
    : arrives.nodes.get(into.parent)?.source;
  if (source === undefined) throw new Error(`move into unknown parent ${into.parent}`);
  const left = out.writer.prepare(LIVE, actor, {
    type: "move",
    node,
    parent: listRoot(into.list),
    rank: was.rank,
    from: { parent: was.parent, rank: was.rank },
  }) as MoveRecord;
  const entered = into.writer.prepare(LIVE, actor, {
    type: "create",
    node,
    kind: was.kind,
    name: nameAmong(arrives, into.parent, was.kind, was.name),
    parent: into.parent,
    source,
    rank: rankAt(arrives, into.parent, into.index ?? Number.MAX_SAFE_INTEGER),
    ...(was.filetype ? { filetype: was.filetype } : {}),
    ...(was.provisional ? { provisional: true as const } : {}),
    ...(was.aliases ? { aliases: was.aliases } : {}),
    ...(was.hasProperties ? { hasProperties: true as const } : {}),
    ...(was.blob ? { blob: was.blob } : {}),
  }) as CreateRecord;
  // Both are built before either is stored, so a move is never left half made.
  out.writer.append(left);
  into.writer.append(entered);
  return { left, entered };
}
