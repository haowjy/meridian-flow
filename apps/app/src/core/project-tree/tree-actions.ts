/**
 * The writer's tree actions: each appends a record to the browser's own copy of the list, so
 * the change shows at once from the replay and Yjs carries it to the server. A name is numbered
 * when the clash is visible in the copy (`TreeWriter`). No action is refused: a node or parent the
 * copy lacks is made as asked and the replay places it or skips it, and a dropped create comes
 * back as a `dropped` settlement on the record (`tree-failures.ts`). A Work that has ended
 * (`TreeVersion.ended`) gets no tree control from the shell; a gesture already under way when it
 * ended lands like any other, and the server drops its creates ("Work was closed").
 * Copy and a move between two lists stay server routes. Each acts in the version the writer is
 * looking at: live, or on Draft the Work's tree, whose records carry the Work's `draft`. Each
 * gesture's records go on the list's sidebar Undo stack (`tree-undo.ts`).
 */
import {
  type NodeKind,
  sourceRoot,
  type TreeProjection,
  type TreeRecord,
  TreeWriter,
  type View,
} from "@meridian/project-tree";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";
import { endWhenRestored, pushUndoStep, shownSourceOf, type TreeStep, undoStep } from "./tree-undo";
import { LIVE_VERSION, type TreeVersion } from "./tree-version";

export class TreeActions {
  constructor(
    /** The list's session, read at each call: a rebuild gives it a new document. */
    private readonly session: () => TreeListSession | null,
    private readonly actor: string,
    /** The tree the writer acts on, read at each call: live, or the Work's on Draft. */
    private readonly version: () => TreeVersion = () => LIVE_VERSION,
  ) {}

  /** The writer on the copy as it stands. */
  private writable(): {
    writer: TreeWriter;
    session: TreeListSession;
    view: View;
    replay: () => TreeProjection;
  } {
    const session = this.session();
    if (!session) throw new Error("There is no tree list to change here.");
    const { doc } = session.getSnapshot();
    const { view, pendingText } = this.version();
    const replay = () => session.replay(view, pendingText);
    // The session's replay is the one every view reads: the writer numbers and ranks against it.
    return {
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
    const step: TreeStep = {
      kind: "tree",
      records: records.map((record) => record.id),
      draft: made.view.draft,
      sources: [...new Set(nodes.flatMap((node) => shownSourceOf(projection, node) ?? []))],
      nodes,
    };
    pushUndoStep(made.session, step);
    return step;
  }

  /** A notice's Undo of a gesture made here: the step the sidebar's Ctrl+Z would take. */
  undo(step: TreeStep): boolean {
    const session = this.session();
    if (!session) return false;
    const { view, pendingText } = this.version();
    return undoStep(session, step, this.actor, view.draft === step.draft ? pendingText : undefined);
  }

  /** Ends `step` once its deleted nodes are out of Trash; the returned stop ends the watch. */
  endWhenRestored(step: TreeStep): () => void {
    const session = this.session();
    return session ? endWhenRestored(session, step) : () => {};
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
  }): { node: string; name: string } {
    const made = this.writable();
    const parent = this.parentOf(made.replay(), input.parentId);
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
    return { node: record.node, name: record.name };
  }

  rename(node: string, name: string, filetype?: string): { name: string } {
    const made = this.writable();
    const record = made.writer.rename(made.view, this.actor, node, name, filetype);
    this.remember(made, [record]);
    return { name: record.name };
  }

  move(node: string, parentId: string, index?: number): void {
    this.moveAll([{ node, parentId, ...(index === undefined ? {} : { index }) }]);
  }

  /** One gesture's moves, each placed among the siblings the ones before it left. */
  moveAll(moves: readonly { node: string; parentId: string; index?: number }[]): void {
    const made = this.writable();
    const replay = made.replay();
    const parents = moves.map((move) => this.parentOf(replay, move.parentId));
    const records = made.writer.moveAll(
      made.view,
      this.actor,
      moves.map((move, at) => ({ ...move, parent: parents[at] as string })),
    );
    this.remember(made, records);
  }

  /** One gesture's deletes as one update; the step is its Undo. */
  remove(nodes: readonly string[]): TreeStep {
    const made = this.writable();
    return this.remember(made, made.writer.deleteAll(made.view, this.actor, nodes));
  }

  restore(nodes: readonly string[]): void {
    const made = this.writable();
    const records: TreeRecord[] = [];
    made.writer.transact(() => {
      for (const node of nodes) records.push(made.writer.restore(made.view, this.actor, node));
    });
    this.remember(made, records);
  }
}
