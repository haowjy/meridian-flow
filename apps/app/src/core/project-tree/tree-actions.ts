/**
 * The writer's tree actions: each appends a record to the browser's own copy of the list, so
 * the change shows at once from the replay and Yjs carries it to the server. A name is numbered
 * when the clash is visible in the copy (`TreeWriter`). There is no request to wait on and none
 * to replay: a refusal comes back as a `refused` settlement on the record (`tree-failures.ts`).
 * Copy and a move between two lists stay server routes.
 */
import {
  isSourceRoot,
  LIVE,
  type NodeKind,
  nameFault,
  sourceRoot,
  TreeWriter,
} from "@meridian/project-tree";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";

/**
 * Why an action did not append. Each is something the writer can act on: the list is read-only,
 * denied or not open yet, the name is not one a node may have, or the folder or node the action
 * names is not in the list (it was deleted, or never was).
 */
export type TreeActionRefusal = "read-only" | "denied" | "no-list" | "name" | "missing";

export type TreeActionResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; reason: TreeActionRefusal };

export class TreeActions {
  constructor(
    /** The list's session, read at each call: a rebuild gives it a new document. */
    private readonly session: () => TreeListSession | null,
    private readonly actor: string,
  ) {}

  /** The writer on the copy as it stands, or why none may write. */
  private writable(): TreeActionResult<{ writer: TreeWriter; session: TreeListSession }> {
    const session = this.session();
    if (!session) return { ok: false, reason: "no-list" };
    const { doc, status } = session.getSnapshot();
    if (status === "read-only" || status === "denied") return { ok: false, reason: status };
    // The session's replay is the one every view reads: the writer numbers and ranks against it.
    return {
      ok: true,
      writer: new TreeWriter(doc, "local", (view) => (view === LIVE ? session.replay() : null)),
      session,
    };
  }

  /** Whether `parent` is a node of the list or the top of a source of it. */
  private holds(session: TreeListSession, parent: string): boolean {
    return isSourceRoot(parent) || session.replay().nodes.has(parent);
  }

  /** The record parent for a folder's id or a source's id (the top of its tree). */
  private parentOf(session: TreeListSession, parentId: string): string {
    return session.replay().nodes.has(parentId) ? parentId : sourceRoot(parentId);
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
    const parent = this.parentOf(made.session, input.parentId);
    if (!this.holds(made.session, parent)) return { ok: false, reason: "missing" };
    const record = made.writer.create(LIVE, this.actor, {
      name: input.name,
      parent,
      ...(input.index === undefined ? {} : { index: input.index }),
      ...(input.node ? { node: input.node } : {}),
      ...(input.provisional ? { provisional: true as const } : {}),
      ...(input.kind === "folder"
        ? { kind: "folder" as const }
        : { kind: "document" as const, filetype: input.filetype ?? "markdown" }),
    });
    return { ok: true, node: record.node, name: record.name };
  }

  rename(node: string, name: string, filetype?: string): TreeActionResult<{ name: string }> {
    const made = this.writable();
    if (!made.ok) return made;
    const current = made.session.replay().nodes.get(node);
    if (!current) return { ok: false, reason: "missing" };
    if (nameFault(current.kind, name) !== null) return { ok: false, reason: "name" };
    return { ok: true, name: made.writer.rename(LIVE, this.actor, node, name, filetype).name };
  }

  move(node: string, parentId: string, index?: number): TreeActionResult {
    return this.moveAll([{ node, parentId, ...(index === undefined ? {} : { index }) }]);
  }

  /** One gesture's moves, each placed among the siblings the ones before it left. */
  moveAll(moves: readonly { node: string; parentId: string; index?: number }[]): TreeActionResult {
    const made = this.writable();
    if (!made.ok) return made;
    const replay = made.session.replay();
    const parents = moves.map((move) => this.parentOf(made.session, move.parentId));
    if (
      moves.some((move) => !replay.nodes.has(move.node)) ||
      parents.some((parent) => !this.holds(made.session, parent))
    )
      return { ok: false, reason: "missing" };
    made.writer.moveAll(
      LIVE,
      this.actor,
      moves.map((move, at) => ({ ...move, parent: parents[at] as string })),
    );
    return { ok: true };
  }

  /** One gesture's deletes as one update. */
  remove(nodes: readonly string[]): TreeActionResult {
    const made = this.writable();
    if (!made.ok) return made;
    if (nodes.some((node) => !made.session.replay().nodes.has(node)))
      return { ok: false, reason: "missing" };
    made.writer.deleteAll(LIVE, this.actor, nodes);
    return { ok: true };
  }

  restore(nodes: readonly string[]): TreeActionResult {
    const made = this.writable();
    if (!made.ok) return made;
    made.writer.transact(() => {
      for (const node of nodes) made.writer.restore(LIVE, this.actor, node);
    });
    return { ok: true };
  }
}
