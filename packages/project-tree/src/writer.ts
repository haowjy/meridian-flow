import type * as Y from "yjs";
import {
  type Actor,
  type BlobRef,
  type CreateRecord,
  type DeleteRecord,
  isSourceRoot,
  listRoot,
  type MoveRecord,
  newId,
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
import { descendantsOf, nameAmong, rankAt } from "./shape.js";
import { writable } from "./validate.js";
import { inForce, LIVE, replayView, type View } from "./view.js";

/**
 * Makes records in one copy of the list, against what that copy's own view shows. The browser
 * writes its own records this way; the server writes Apply, Discard, Undo and an AI tool's
 * records on a copy at the journal's head, and sends the Yjs update the copy emits.
 */
export class TreeWriter {
  constructor(
    readonly doc: Y.Doc,
    private readonly origin: string = "local",
  ) {}

  view(view: View): TreeProjection {
    return replayView(this.doc, view);
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

  create(
    view: View,
    actor: Actor,
    input: {
      name: string;
      parent: string;
      index?: number;
      node?: string;
      provisional?: true;
    } & (
      | { kind: "folder" }
      | { kind: "document"; filetype: string }
      | { kind: "file"; blob?: BlobRef }
    ),
  ): CreateRecord {
    const projection = this.view(view);
    const source = isSourceRoot(input.parent)
      ? sourceIdOf(input.parent)
      : projection.nodes.get(input.parent)?.source;
    if (source === undefined) throw new Error(`create under unknown parent ${input.parent}`);
    return this.author(view, actor, {
      type: "create",
      node: input.node ?? newId(),
      kind: input.kind,
      name: nameAmong(projection, input.parent, input.kind, input.name),
      parent: input.parent,
      source,
      rank: rankAt(projection, input.parent, input.index ?? Number.MAX_SAFE_INTEGER),
      ...(input.kind === "document" ? { filetype: input.filetype } : {}),
      ...(input.provisional ? { provisional: true as const } : {}),
      ...(input.kind === "file" && input.blob ? { blob: input.blob } : {}),
    }) as CreateRecord;
  }

  move(
    view: View,
    actor: Actor,
    node: string,
    parent: string,
    index = Number.MAX_SAFE_INTEGER,
  ): MoveRecord {
    const projection = this.view(view);
    const current = projection.nodes.get(node);
    return this.author(view, actor, {
      type: "move",
      node,
      parent,
      rank: rankAt(projection, parent, index, node),
      from: { parent: current?.parent ?? parent, rank: current?.rank ?? "" },
    }) as MoveRecord;
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

  delete(view: View, actor: Actor, node: string): DeleteRecord {
    const projection = this.view(view);
    const cascade = descendantsOf(projection, node).filter(
      (id) => !projection.nodes.get(id)?.trashed,
    );
    return this.author(view, actor, { type: "delete", node, cascade }) as DeleteRecord;
  }

  restore(view: View, actor: Actor, node: string): RestoreRecord {
    return this.author(view, actor, { type: "restore", node }) as RestoreRecord;
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
