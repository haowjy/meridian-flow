/**
 * The writer's tree actions: each appends a record to the browser's own copy of the list, so
 * the change shows at once from the replay and Yjs carries it to the server. A name is numbered
 * when the clash is visible in the copy (`TreeWriter`). There is no request to wait on and none
 * to replay: a refusal comes back as a `refused` settlement on the record (`tree-failures.ts`).
 * Copy and a move between two lists stay server routes.
 */
import { LIVE, type NodeKind, sourceRoot, TreeWriter } from "@meridian/project-tree";
import type { TreeListSession } from "@/core/tree-list/tree-list-session";

/** Why an action did not append: nothing the writer did wrong. */
export type TreeActionRefusal = "read-only" | "denied" | "no-list";

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
    return { ok: true, writer: new TreeWriter(doc), session };
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
    const parent = this.parentOf(made.session, input.parentId);
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
    return { ok: true, name: made.writer.rename(LIVE, this.actor, node, name, filetype).name };
  }

  move(node: string, parentId: string, index?: number): TreeActionResult {
    const made = this.writable();
    if (!made.ok) return made;
    made.writer.move(LIVE, this.actor, node, this.parentOf(made.session, parentId), index);
    return { ok: true };
  }

  /** One gesture's deletes as one update. */
  remove(nodes: readonly string[]): TreeActionResult {
    const made = this.writable();
    if (!made.ok) return made;
    made.writer.transact(() => {
      for (const node of nodes) made.writer.delete(LIVE, this.actor, node);
    });
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
