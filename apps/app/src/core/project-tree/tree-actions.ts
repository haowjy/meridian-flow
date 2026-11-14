/**
 * The writer's tree actions: each appends a record to the browser's own copy of the list, so
 * the change shows at once from the replay and Yjs carries it to the server. A name is numbered
 * when the clash is visible in the copy (`TreeWriter`). There is no request to wait on and none
 * to replay: a refusal comes back as a `refused` settlement on the record (`tree-failures.ts`).
 * Copy and a move between two lists stay server routes. Each acts in the version the writer is
 * looking at: live, or on Draft the Work's tree, whose records carry the Work's `draft`. Each
 * gesture's records go on the list's sidebar Undo stack (`tree-undo.ts`).
 */
import {
  isSourceRoot,
  type NodeKind,
  nameFault,
  sourceRoot,
  type TreeProjection,
  type TreeRecord,
  TreeWriter,
  type View,
} from "@meridian/project-tree";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";
import { pushUndoStep, shownSourceOf } from "./tree-undo";
import { LIVE_VERSION, type TreeVersion } from "./tree-version";

/**
 * Why an action did not append. Each is something the writer can act on: the list is read-only,
 * denied or not open yet, the name is not one a node may have, or the folder or node the action
 * names is not in the list (it was deleted, or never was).
 */
export type TreeActionRefusal =
  | "read-only"
  | "archived"
  | "deleted"
  | "denied"
  | "no-list"
  | "name"
  | "missing";

export type TreeActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; reason: TreeActionRefusal };

export class TreeActions {
  constructor(
    /** The list's session, read at each call: a rebuild gives it a new document. */
    private readonly session: () => TreeListSession | null,
    private readonly actor: string,
    /** The tree the writer acts on, read at each call: live, or the Work's on Draft. */
    private readonly version: () => TreeVersion = () => LIVE_VERSION,
  ) {}

  /** The writer on the copy as it stands, or why none may write. */
  private writable(): TreeActionResult<{
    writer: TreeWriter;
    session: TreeListSession;
    view: View;
    replay: () => TreeProjection;
  }> {
    const session = this.session();
    if (!session) return { ok: false, reason: "no-list" };
    const { doc, status } = session.getSnapshot();
    if (status === "read-only" || status === "denied") return { ok: false, reason: status };
    const { view, pendingText, ended } = this.version();
    if (ended) return { ok: false, reason: ended };
    const replay = () => session.replay(view, pendingText);
    // The session's replay is the one every view reads: the writer numbers and ranks against it.
    return {
      ok: true,
      writer: new TreeWriter(doc, "local", (asked) => (asked === view ? replay() : null)),
      session,
      view,
      replay,
    };
  }

  /** The gesture's records go on the list's Undo stack, under the sources its nodes show in. */
  private remember(
    made: { session: TreeListSession; view: View; replay: () => TreeProjection },
    records: readonly TreeRecord[],
  ) {
    const projection = made.replay();
    const nodes = [...new Set(records.map((record) => record.node))];
    pushUndoStep(made.session, {
      kind: "tree",
      records: records.map((record) => record.id),
      draft: made.view.draft,
      sources: [...new Set(nodes.flatMap((node) => shownSourceOf(projection, node) ?? []))],
      nodes,
    });
  }

  /** The record parent for a folder's id or a source's id (the top of its tree). */
  private parentOf(replay: TreeProjection, parentId: string): string {
    return replay.nodes.has(parentId) ? parentId : sourceRoot(parentId);
  }

  create(input: {
    parentId: string;
    name: string;
    index?: number;
    node?: string;
    provisional?: true;
    kind: Exclude<NodeKind, "file">;
    filetype?: string;
  }): TreeActionResult<{ node: string; name: string }> {
    const made = this.writable();
    if (!made.ok) return made;
    const kind = input.kind === "folder" ? "folder" : "document";
    if (nameFault(kind, input.name) !== null) return { ok: false, reason: "name" };
    const replay = made.replay();
    const parent = this.parentOf(replay, input.parentId);
    if (!holds(replay, parent)) return { ok: false, reason: "missing" };
    const record = made.writer.create(made.view, this.actor, {
      name: input.name,
      parent,
      ...(input.index === undefined ? {} : { index: input.index }),
      ...(input.node ? { node: input.node } : {}),
      ...(input.provisional ? { provisional: true as const } : {}),
      ...(input.kind === "folder"
        ? { kind: "folder" as const }
        : { kind: "document" as const, filetype: input.filetype ?? "markdown" }),
    });
    this.remember(made, [record]);
    return { ok: true, node: record.node, name: record.name };
  }

  rename(node: string, name: string, filetype?: string): TreeActionResult<{ name: string }> {
    const made = this.writable();
    if (!made.ok) return made;
    const current = made.replay().nodes.get(node);
    if (!current) return { ok: false, reason: "missing" };
    if (nameFault(current.kind, name) !== null) return { ok: false, reason: "name" };
    const record = made.writer.rename(made.view, this.actor, node, name, filetype);
    this.remember(made, [record]);
    return { ok: true, name: record.name };
  }

  move(node: string, parentId: string, index?: number): TreeActionResult {
    return this.moveAll([{ node, parentId, ...(index === undefined ? {} : { index }) }]);
  }

  /** One gesture's moves, each placed among the siblings the ones before it left. */
  moveAll(moves: readonly { node: string; parentId: string; index?: number }[]): TreeActionResult {
    const made = this.writable();
    if (!made.ok) return made;
    const replay = made.replay();
    const parents = moves.map((move) => this.parentOf(replay, move.parentId));
    if (
      moves.some((move) => !replay.nodes.has(move.node)) ||
      parents.some((parent) => !holds(replay, parent))
    )
      return { ok: false, reason: "missing" };
    const records = made.writer.moveAll(
      made.view,
      this.actor,
      moves.map((move, at) => ({ ...move, parent: parents[at] as string })),
    );
    this.remember(made, records);
    return { ok: true };
  }

  /** One gesture's deletes as one update. */
  remove(nodes: readonly string[]): TreeActionResult {
    const made = this.writable();
    if (!made.ok) return made;
    const replay = made.replay();
    if (nodes.some((node) => !replay.nodes.has(node))) return { ok: false, reason: "missing" };
    this.remember(made, made.writer.deleteAll(made.view, this.actor, nodes));
    return { ok: true };
  }

  restore(nodes: readonly string[]): TreeActionResult {
    const made = this.writable();
    if (!made.ok) return made;
    const records: TreeRecord[] = [];
    made.writer.transact(() => {
      for (const node of nodes) records.push(made.writer.restore(made.view, this.actor, node));
    });
    this.remember(made, records);
    return { ok: true };
  }
}

/** Whether `parent` is a node of the view or the top of a source. */
const holds = (replay: TreeProjection, parent: string): boolean =>
  isSourceRoot(parent) || replay.nodes.has(parent);
