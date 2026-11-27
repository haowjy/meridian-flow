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
    private readonly version: () => TreeVersion = () => LIVE_VERSION,
    private readonly closed: ClosedOwners = NOTHING_CLOSED,
  ) {}

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
    return {
      writer: new TreeWriter(doc, "local", (asked) => (asked === view ? replay() : null)),
      session,
      view,
      replay,
    };
  }

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

  undo(step: UndoStep): Promise<boolean> {
    const session = this.session();
    if (!session) return Promise.resolve(false);
    return undoStep(session, step, this.actor, this.closed);
  }

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

  remove(nodes: readonly string[]): TreeStep {
    const made = this.writable();
    const replay = made.replay();
    const step = this.remember(
      made,
      "delete",
      replay,
      made.writer.deleteAll(made.view, this.actor, nodes),
    );
    endWhenRestored(made.session, step);
    return step;
  }

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
