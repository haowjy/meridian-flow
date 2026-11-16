/**
 * ContextFS's tree writes in one source: each is one `treeListStore.submit` on the source's list,
 * made in the caller's transaction at the call. The path is resolved against the list's own copy
 * inside `make`, under the list's lock, so a name another writer took a moment ago is seen and
 * nothing is checked twice. A write answers with what the replay shows afterwards (final names
 * and paths); a refusal makes no record.
 *
 * Callers hold the Work and branch locks their command transaction took and no document or
 * namespace key (the list's key sorts before those).
 */
import type { BranchId, DocumentId } from "@meridian/contracts";
import type { ContextSiblingPosition, Filetype } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import {
  type Actor,
  type BlobRef,
  childrenOf,
  isSourceRoot,
  LIVE,
  sourceRoot,
  type TreeNode,
  type TreeProjection,
  type TreeRecordInput,
  type TreeWriter,
  type View,
} from "@meridian/project-tree";
import { eq } from "drizzle-orm";
import { generateNKeysBetween } from "fractional-indexing";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type { DocumentCreationMetadata } from "../../document-metadata.js";
import type { AdapterFault, TreeScope } from "../../ports/context-adapter.js";
import type { WriteProvenance } from "../../ports/context-port.js";
import {
  type ListWriter,
  type TreeList,
  type TreeListStore,
  TreeRefusal,
} from "../../ports/tree-list-store.js";
import { treeListOfSource } from "../tree-list-facts.js";

/** Who makes a record: `agent:<chat>/<turn>` for the model, `user:<id>` for a person, else the server. */
export function actorOf(origin: WriteProvenance | undefined): Actor {
  if (origin?.type === "agent") return `agent:${origin.threadId}/${origin.turnId}`;
  if (origin?.type === "human") return `user:${origin.userId}`;
  return "system";
}

/** The user or chat a record's actor string names; null for the server's own. */
export function parseActor(
  actor: string | null | undefined,
): { kind: "user"; userId: string } | { kind: "agent"; chatId: string } | null {
  if (actor?.startsWith("user:")) return { kind: "user", userId: actor.slice("user:".length) };
  if (actor?.startsWith("agent:"))
    return { kind: "agent", chatId: actor.slice("agent:".length).split("/")[0] ?? "" };
  return null;
}

/** The Work's draft view for a branch, or live. */
export function viewOfBranch(branchId: BranchId | null): View {
  return branchId === null ? LIVE : { draft: branchId };
}

export type TreeWriteTarget = { view: View; actor: Actor };

type Occupant = "file" | "folder";

const conflict = (occupantKind?: Occupant): AdapterFault => ({
  code: "conflict",
  ...(occupantKind ? { occupantKind } : {}),
});

const occupantKindOf = (node: TreeNode): Occupant => (node.kind === "folder" ? "folder" : "file");

/** The shown child of `parent` that has this stored filename, if any. */
function childNamed(
  projection: TreeProjection,
  parent: string,
  filename: string,
): TreeNode | undefined {
  return childrenOf(projection, parent).find((node) => node.displayName === filename);
}

/** `id`'s address in its source: the folders' names from the source's top, its own name last. */
function pathOf(projection: TreeProjection, id: string): string[] {
  const names: string[] = [];
  for (
    let node = projection.nodes.get(id);
    node;
    node = isSourceRoot(node.parent) ? undefined : projection.nodes.get(node.parent)
  )
    names.unshift(node.displayName);
  return names;
}

/**
 * Folders along `dir` from `from`, made where missing, each pushed to `made`. A document or file
 * on the way refuses with the occupant's kind.
 */
function ensureFolders(
  writer: TreeWriter,
  target: TreeWriteTarget,
  dir: readonly string[],
  from: string,
  made: MadeFolder[] = [],
): Result<string, AdapterFault> {
  let parent = from;
  for (const name of dir) {
    const existing = childNamed(writer.view(target.view), parent, name);
    if (existing) {
      if (existing.kind !== "folder") return Err(conflict("file"));
      parent = existing.id;
      continue;
    }
    const created = writer.create(target.view, target.actor, { kind: "folder", name, parent });
    made.push({ record: created.id, node: created.node });
    parent = created.node;
  }
  return Ok(parent);
}

/** An existing folder along `dir`; none is made. */
function findFolder(
  projection: TreeProjection,
  sourceId: string,
  dir: readonly string[],
): string | null {
  let parent = sourceRoot(sourceId);
  for (const name of dir) {
    const existing = childNamed(projection, parent, name);
    if (existing?.kind !== "folder") return null;
    parent = existing.id;
  }
  return parent;
}

/** Where among `parent`'s shown children a position puts a node; an anchor that is gone means the end. */
function indexAt(
  projection: TreeProjection,
  parent: string,
  position: ContextSiblingPosition | undefined,
  moving?: string,
): number {
  const siblings = childrenOf(projection, parent).filter((node) => node.id !== moving);
  if (!position || position.kind === "end") return siblings.length;
  if (position.kind === "start") return 0;
  if (!("siblingId" in position)) return siblings.length;
  const at = siblings.findIndex((node) => node.id === position.siblingId);
  if (at < 0) return siblings.length;
  return position.kind === "before" ? at : at + 1;
}

/** `record` is the create record, which a receipt names for Undo. */
/** A folder a create made on the way: part of that create's change, so its Undo takes it back. */
export type MadeFolder = { record: string; node: string };

export type CreatedNode = {
  id: string;
  record: string;
  /** The folders made for it, outermost first. */
  folders: MadeFolder[];
  name: string;
  path: string[];
};

export type DeletedNode = {
  /** The documents and files the delete took, the node itself among them. */
  documentIds: string[];
  path: string[];
};

/** One node of a tree to insert, under the id it will have. */
export type NewNode =
  | { kind: "folder"; id: string; filename: string; children: readonly NewNode[] }
  | {
      kind: "document";
      id: string;
      filename: string;
      filetype: Filetype;
      metadata?: DocumentCreationMetadata;
    }
  | {
      kind: "file";
      id: string;
      filename: string;
      blob: BlobRef;
      hasPreview?: boolean;
      metadata?: DocumentCreationMetadata;
    };

export interface SourceTree {
  /** This source's id, provisioned. */
  sourceId(): Promise<string>;
  /** A document or stored file at `dir`/`filename`, its folders made as needed. */
  create(
    target: TreeWriteTarget,
    input: {
      dir: readonly string[];
      filename: string;
      kind: "document" | "file";
      filetype?: Filetype;
      blob?: BlobRef;
      /** A node id the caller reserved. */
      id?: string;
      /** The folder node it goes in, found already (`ContextEnsureTrackedOptions.into`); else `dir` is. */
      into?: string;
      provisional?: boolean;
      position?: ContextSiblingPosition;
      /** Stored on the document's row beside the tree (`documents.metadata`, `has_preview`). */
      metadata?: DocumentCreationMetadata;
      hasPreview?: boolean;
    },
  ): Promise<Result<CreatedNode, AdapterFault>>;
  /**
   * The node at `dir`/`filename` in the view, whichever kind, or null: what an ensure reads
   * before it creates.
   */
  find(
    target: TreeWriteTarget,
    dir: readonly string[],
    filename: string,
    into?: string,
  ): Promise<{ id: string; kind: "document" | "file" | "folder" } | null>;
  /** Deletes the node and what is inside it, in live: one Trash entry. */
  delete(
    target: TreeWriteTarget,
    input: { node: string; kind: "file" | "folder"; fromSourceId: string; onlyAt?: string },
  ): Promise<Result<DeletedNode, AdapterFault>>;
  /**
   * Trees of new nodes at their destination folders, made as one change: folders before what
   * they hold, children in the order given. Each root must find its name free in its folder,
   * else the answer is `replan` and nothing is made.
   */
  insertTree(
    target: TreeWriteTarget,
    input: {
      trees: readonly {
        dir: readonly string[];
        /** The folder to start from, by id, instead of walking `dir` by name: a folder in Trash is kept standing by what lands in it. */
        parent?: { folderId: string; createFolders: readonly string[] };
        roots: readonly NewNode[];
      }[];
      position?: ContextSiblingPosition;
    },
  ): Promise<Result<{ kind: "inserted"; folders: string[] } | { kind: "replan" }, AdapterFault>>;
  /**
   * One tree command on this source's list: `make` runs under the list's lock on the copy at the
   * journal's head, makes whatever records it decides on and returns its answer. A refused answer
   * stores nothing: what `make` wrote before it refused is dropped with the copy, as a throw does.
   */
  run<T>(
    target: TreeWriteTarget,
    make: (scope: TreeScope) => { result: T; refused?: boolean },
  ): Promise<T>;
  /** What this source's tree shows in `view`, at the journal's head. */
  read<T>(view: View, read: (scope: Pick<TreeScope, "writer" | "root" | "view">) => T): Promise<T>;
}

export function createSourceTree(deps: {
  store: Pick<TreeListStore, "submit" | "read">;
  db: Database;
  sourceId(): Promise<string>;
}): SourceTree {
  const list = async () => treeListOfSource(deps.db, await deps.sourceId());

  /**
   * One write on these lists whose answer is a `Result`: an `Err` aborts it, so nothing the
   * maker did to the copies is stored and they reload (a refusal after folders were made must
   * not leave them behind).
   */
  async function write<T>(
    lists: readonly TreeList[],
    make: (copies: readonly ListWriter[]) => Result<T, AdapterFault>,
  ): Promise<Result<T, AdapterFault>> {
    try {
      const { result } = await deps.store.submit({
        lists,
        make: (copies) => {
          const made = make(copies);
          if (!made.ok) throw new TreeRefusal(made.error);
          return made;
        },
      });
      return result;
    } catch (cause) {
      if (cause instanceof TreeRefusal) return Err(cause.reason as AdapterFault);
      throw cause;
    }
  }

  /** The columns of `documents` beside the tree: metadata and preview, for created nodes. */
  const annotateTree = async (nodes: readonly NewNode[]): Promise<void> => {
    for (const node of nodes) {
      if (node.kind === "folder") await annotateTree(node.children);
      else if (node.metadata || (node.kind === "file" && node.hasPreview))
        await currentDrizzleDb(deps.db)
          .update(documents)
          .set({
            ...(node.metadata ? { metadata: node.metadata } : {}),
            ...(node.kind === "file" && node.hasPreview ? { hasPreview: true } : {}),
          })
          .where(eq(documents.id, node.id as DocumentId));
    }
  };

  return {
    sourceId: deps.sourceId,

    async create(target, input) {
      const sourceId = await deps.sourceId();
      const result = await write<CreatedNode>([await list()], ([{ writer }]) => {
        const folders: MadeFolder[] = [];
        const parent =
          input.into === undefined
            ? ensureFolders(writer, target, input.dir, sourceRoot(sourceId), folders)
            : Ok(input.into);
        if (!parent.ok) return parent;
        const occupant = childNamed(writer.view(target.view), parent.value, input.filename);
        if (occupant) return Err(conflict(occupantKindOf(occupant)));
        const index = indexAt(writer.view(target.view), parent.value, input.position);
        const created = writer.create(target.view, target.actor, {
          kind: input.kind,
          name: input.filename,
          parent: parent.value,
          index,
          ...(input.id ? { node: input.id } : {}),
          ...(input.provisional ? { provisional: true as const } : {}),
          ...(input.kind === "document"
            ? { filetype: input.filetype as Filetype }
            : { blob: input.blob }),
        } as Parameters<TreeWriter["create"]>[2]);
        const shown = writer.view(target.view);
        return Ok({
          id: created.node,
          record: created.id,
          folders,
          name: shown.nodes.get(created.node)?.displayName ?? input.filename,
          path: pathOf(shown, created.node),
        });
      });
      if (result.ok && (input.metadata || input.hasPreview))
        await currentDrizzleDb(deps.db)
          .update(documents)
          .set({
            ...(input.metadata ? { metadata: input.metadata } : {}),
            ...(input.hasPreview ? { hasPreview: true } : {}),
          })
          .where(eq(documents.id, result.value.id as DocumentId));
      return result;
    },

    async find(target, dir, filename, into) {
      const sourceId = await deps.sourceId();
      return deps.store.read({
        lists: [await list()],
        view: ([{ writer }]) => {
          const projection = writer.view(target.view);
          const parent = into ?? findFolder(projection, sourceId, dir);
          const found = parent === null ? undefined : childNamed(projection, parent, filename);
          return found ? { id: found.id, kind: found.kind } : null;
        },
      });
    },

    async delete(target, input) {
      return write<DeletedNode>([await list()], ([{ writer }]) => {
        const projection = writer.view(target.view);
        const node = projection.nodes.get(input.node);
        if (!node || node.trashed || node.purged) return Err({ code: "not_found" } as AdapterFault);
        if ((input.kind === "file") !== (node.kind !== "folder"))
          return Err({ code: "not_found" } as AdapterFault);
        if (node.source !== input.fromSourceId)
          return Err({ code: "stale_source" } as AdapterFault);
        const path = pathOf(projection, node.id);
        if (input.onlyAt !== undefined && path.join("/") !== input.onlyAt)
          return Err({ code: "stale_target" } as AdapterFault);
        const record = writer.delete(target.view, target.actor, node.id);
        const taken = [node.id, ...record.cascade].flatMap((id) => {
          const taken = projection.nodes.get(id);
          return taken && taken.kind !== "folder" ? [id] : [];
        });
        return Ok({ documentIds: taken, path });
      });
    },

    async insertTree(target, input) {
      const sourceId = await deps.sourceId();
      const result = await write<{ kind: "inserted"; folders: string[] } | { kind: "replan" }>(
        [await list()],
        ([{ writer }]) => {
          const before = writer.view(target.view);
          for (const tree of input.trees) {
            const parent = tree.parent
              ? tree.parent.createFolders.length
                ? null
                : tree.parent.folderId
              : findFolder(before, sourceId, tree.dir);
            if (
              parent !== null &&
              tree.roots.some((root) => childNamed(before, parent, root.filename))
            )
              return Ok({ kind: "replan" as const });
          }
          const made: MadeFolder[] = [];
          const groups: { roots: readonly NewNode[]; parent: string }[] = [];
          for (const tree of input.trees) {
            const parent = tree.parent
              ? ensureFolders(writer, target, tree.parent.createFolders, tree.parent.folderId, made)
              : ensureFolders(writer, target, tree.dir, sourceRoot(sourceId), made);
            if (!parent.ok) return parent;
            groups.push({ roots: tree.roots, parent: parent.value });
          }
          for (const group of groups) {
            const projection = writer.view(target.view);
            // Ranks are minted once per level: a create's own replay per node would cost a
            // replay of the whole list each.
            const at = indexAt(projection, group.parent, input.position);
            const siblings = childrenOf(projection, group.parent);
            const rootRanks = generateNKeysBetween(
              siblings[at - 1]?.rank ?? null,
              siblings[at]?.rank ?? null,
              group.roots.length,
            );
            const put = (node: NewNode, parentId: string, rank: string) => {
              writer.author(target.view, target.actor, {
                type: "create",
                kind: node.kind,
                node: node.id,
                name: node.filename,
                parent: parentId,
                source: sourceId,
                rank,
                ...(node.kind === "document" ? { filetype: node.filetype } : {}),
                ...(node.kind === "file" ? { blob: node.blob } : {}),
              } as TreeRecordInput);
              if (node.kind !== "folder") return;
              const ranks = generateNKeysBetween(null, null, node.children.length);
              for (const [index, child] of node.children.entries())
                put(child, node.id, ranks[index] as string);
            };
            for (const [index, root] of group.roots.entries())
              put(root, group.parent, rootRanks[index] as string);
          }
          return Ok({ kind: "inserted" as const, folders: made.map((folder) => folder.node) });
        },
      );
      if (result.ok && result.value.kind === "inserted")
        await annotateTree(input.trees.flatMap((tree) => [...tree.roots]));
      return result;
    },

    async run<T>(
      target: TreeWriteTarget,
      make: (scope: TreeScope) => { result: T; refused?: boolean },
    ) {
      const root = sourceRoot(await deps.sourceId());
      try {
        const { result } = await deps.store.submit({
          lists: [await list()],
          make: ([{ writer }]) => {
            const made = make({ writer, view: target.view, actor: target.actor, root });
            if (made.refused) throw new TreeRefusal(made.result);
            return made;
          },
        });
        return result.result;
      } catch (cause) {
        if (cause instanceof TreeRefusal) return cause.reason as T;
        throw cause;
      }
    },

    async read(view, read) {
      const root = sourceRoot(await deps.sourceId());
      return deps.store.read({
        lists: [await list()],
        view: ([{ writer }]) => read({ writer, view, root }),
      });
    },
  };
}
