/**
 * The writer's tree actions: each appends a record to the browser's own copy of the list, so
 * the change shows at once from the replay and Yjs carries it to the server. No action is refused:
 * a node or parent the
 * copy lacks is made as asked and the replay places it or skips it. A change to a Work that was
 * closed is sent like any other; the server stamps it `dropped` ("Work was closed"), every replay
 * leaves it out, and its row says so (`tree-bounces.ts`). A deleted Work (`TreeVersion.ended`)
 * gets no tree control from the shell; an archived one keeps them.
 * Copy and a move between two lists stay server routes. Each acts in the version the writer is
 * looking at: live, or on Draft the Work's tree, whose records carry the Work's `draft`. Each
 * gesture's records go on the list's sidebar Undo stack (`tree-undo.ts`).
 */
import {
  childrenOf,
  isSourceRoot,
  type NodeKind,
  pathOf,
  sourceIdOf,
  sourceRoot,
  type TreeProjection,
  type TreeRecord,
  TreeWriter,
  type View,
} from "@meridian/project-tree";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";
import {
  type ClosedOwners,
  endWhenRestored,
  NOTHING_CLOSED,
  pushUndoStep,
  shownSourceOf,
  type TreeGesture,
  type TreeStep,
  type UndoStep,
  undoStep,
  type Was,
} from "./tree-undo";
import { LIVE_VERSION, type TreeVersion } from "./tree-version";
import type { TreeDestination, TreeView } from "./tree-view";

export class TreeActions {
  constructor(
    /** The list's session, read at each call: a rebuild gives it a new document. */
    private readonly session: () => TreeListSession | null,
    private readonly actor: string,
    /** The tree the writer acts on, read at each call: live, or the Work's on Draft. */
    private readonly version: () => TreeVersion = () => LIVE_VERSION,
    /** Which owners are closed now: a step that waits for them is passed over. */
    private readonly closed: ClosedOwners = NOTHING_CLOSED,
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
    const { view } = this.version();
    const replay = () => session.replay(view);
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
    gesture: TreeGesture,
    before: TreeProjection,
    records: readonly TreeRecord[],
  ) {
    const projection = made.replay();
    const nodes = [...new Set(records.map((record) => record.node))];
    const was = new Map(
      nodes.flatMap((node) => {
        const at = before.nodes.get(node);
        if (!at) return [];
        const top = isSourceRoot(at.parent);
        const siblings = childrenOf(before, at.parent).map((child) => child.id);
        const was: Was = {
          name: at.name,
          kind: at.kind === "folder" ? "folder" : "document",
          folder: top ? null : (before.nodes.get(at.parent)?.name ?? null),
          parent: top ? sourceIdOf(at.parent) : at.parent,
          after: siblings.slice(0, siblings.indexOf(node)).reverse(),
        };
        return [[node, was] as const];
      }),
    );
    const step: TreeStep = {
      kind: "tree",
      gesture,
      was,
      records: records.map((record) => record.id),
      draft: made.view.draft,
      sources: [...new Set(nodes.flatMap((node) => shownSourceOf(projection, node) ?? []))],
      nodes,
    };
    pushUndoStep(made.session, step);
    return step;
  }

  /** A notice's Undo of a step made here: the step the sidebar's Ctrl+Z would take. */
  undo(step: UndoStep): Promise<boolean> {
    const session = this.session();
    if (!session) return Promise.resolve(false);
    return undoStep(session, step, this.actor, this.closed);
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
  }): { node: string; name: string; path: string | undefined } {
    const made = this.writable();
    const before = made.replay();
    const parent = this.parentOf(before, input.parentId);
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
    this.remember(made, "create", before, [record]);
    return { node: record.node, name: record.name, path: this.pathOf(record.node) };
  }

  /**
   * Where a node is now in the version acted on: a twin of a name already in its folder takes a
   * `~` suffix, so the typed name may reach the other one. None when the replay doesn't show it.
   */
  pathOf(node: string): string | undefined {
    const replay = this.writable().replay();
    const at = replay.nodes.get(node);
    return at ? pathOf(replay, at) : undefined;
  }

  rename(node: string, name: string, filetype?: string): { name: string } {
    const made = this.writable();
    const before = made.replay();
    const record = made.writer.rename(made.view, this.actor, node, name, filetype);
    this.remember(made, "rename", before, [record]);
    return { name: record.name };
  }

  move(node: string, parentId: string): void {
    this.moveAll([node], { parentId });
  }

  /** One gesture's moves: the nodes land in `to` together, in order, as one Undo. */
  moveAll(nodes: readonly string[], to: TreeDestination): void {
    const made = this.writable();
    const replay = made.replay();
    const records = made.writer.moveAll(
      made.view,
      this.actor,
      nodes,
      this.parentOf(replay, to.parentId),
      to.position,
    );
    this.remember(made, "move", replay, records);
  }

  /** One gesture's deletes as one update; the step is its Undo. */
  remove(nodes: readonly string[]): TreeStep {
    const made = this.writable();
    const replay = made.replay();
    const step = this.remember(
      made,
      "delete",
      replay,
      made.writer.deleteAll(made.view, this.actor, nodes),
    );
    // Once nothing it deleted is in Trash any more (restored anywhere, purged), its Undo ends.
    endWhenRestored(made.session, step);
    return step;
  }

  /**
   * Brings nodes back from Trash, where they were or, dragged out, together into `into`: one
   * gesture, one Undo.
   */
  restore(nodes: readonly string[], into?: TreeDestination): { records: readonly TreeRecord[] } {
    const made = this.writable();
    const before = made.replay();
    const records: TreeRecord[] = [];
    made.writer.transact(() => {
      for (const node of nodes) records.push(made.writer.restore(made.view, this.actor, node));
    });
    if (into)
      records.push(
        ...made.writer.moveAll(
          made.view,
          this.actor,
          nodes,
          this.parentOf(made.replay(), into.parentId),
          into.position,
        ),
      );
    this.remember(made, "restore", before, records);
    return { records };
  }
}

/** The id of the folder at `path` in `view`: the deepest one that exists, then the ones it lacks. */
export function makeFolders(view: TreeView, actions: TreeActions, path: string): string {
  const folders = path.split("/").filter(Boolean);
  const missing: string[] = [];
  let found = view.findFolder(folders.join("/"));
  while (!found) {
    missing.unshift(folders.pop() as string);
    found = view.findFolder(folders.join("/"));
  }
  let parentId = found.entryId;
  for (const name of missing) parentId = actions.create({ parentId, name, kind: "folder" }).node;
  return parentId;
}
