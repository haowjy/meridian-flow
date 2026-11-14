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
import {
  type ContextSiblingPosition,
  classifyFiletype,
  type Filetype,
  storedFilename,
} from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import {
  type Actor,
  type BlobRef,
  type CreateRecord,
  childrenOf,
  isSourceRoot,
  LIVE,
  type MoveRecord,
  moveBetweenLists,
  pendingRecords,
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

function extensionOf(node: TreeNode): string {
  if (node.kind === "folder") return "";
  const dot = node.displayName.lastIndexOf(".");
  return dot > 0 ? node.displayName.slice(dot + 1).toLowerCase() : "";
}

/**
 * Folders along `dir` from the source's top, made where missing. A document or file on the way
 * refuses with the occupant's kind.
 */
function ensureFolders(
  writer: TreeWriter,
  target: TreeWriteTarget,
  sourceId: string,
  dir: readonly string[],
): Result<string, AdapterFault> {
  let parent = sourceRoot(sourceId);
  for (const name of dir) {
    const existing = childNamed(writer.view(target.view), parent, name);
    if (existing) {
      if (existing.kind !== "folder") return Err(conflict("file"));
      parent = existing.id;
      continue;
    }
    parent = writer.create(target.view, target.actor, { kind: "folder", name, parent }).node;
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

/** A document's type as a tracked or stored file, for the type a rename may keep. */
function typeConversion(
  node: TreeNode,
  filename: string,
  filetype: Filetype | null,
): AdapterFault | null {
  if (filetype === null) return null;
  if (node.kind === "file") {
    if (classifyFiletype(filetype).kind !== "tracked") return null;
    return {
      code: "invalid_operation",
      reason: "file_type_conversion",
      message: `Cannot rename storage-backed file ${node.displayName} to ${filename} because tracked documents require a Yjs schema`,
    };
  }
  const was = classifyFiletype((node.filetype ?? "markdown") as Filetype);
  const now = classifyFiletype(filetype);
  if (now.kind !== "tracked")
    return {
      code: "invalid_operation",
      reason: "file_type_conversion",
      message: `Cannot rename tracked document ${node.displayName} to ${filename} because binary and custom files use a different storage model`,
    };
  if (was.kind === "tracked" && now.schemaType !== was.schemaType)
    return {
      code: "invalid_operation",
      reason: "document_type_conversion",
      message: `Cannot rename ${node.displayName} to ${filename} because changing the Yjs schema from ${was.schemaType} to ${now.schemaType} requires an explicit conversion`,
    };
  return null;
}

/** `record` is the create record, which a receipt names for Undo. */
export type CreatedNode = { id: string; record: string; name: string; path: string[] };

/** A document or file that left one list for another: the pair of records, one in each list. */
export type MovedAcrossLists = {
  left: MoveRecord;
  entered: CreateRecord;
  /** The node's path in the list it entered. */
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
  ): Promise<{ id: string; kind: "document" | "file" | "folder" } | null>;
  /**
   * Moves a document or file from the list of `fromSourceId` into `dir` of this source, which
   * is in another list (a project's and the account's `user://`): one transaction on both
   * lists, the pair of records `moveBetweenLists` makes. The node is found by id; `leaf` is
   * the name the writer typed, else it keeps its own. Live only; a folder does not cross.
   */
  moveAcrossLists(
    target: TreeWriteTarget,
    input: {
      node: string;
      /** The source the caller found it in: a node found elsewhere is `stale_source`. */
      fromSourceId: string;
      /** The folder it lands in, below this source's top. */
      dir: readonly string[];
      leaf?: string;
      position?: ContextSiblingPosition;
      /** Move only while the node stands at this source-relative path. */
      onlyAt?: string;
    },
  ): Promise<Result<MovedAcrossLists, AdapterFault>>;
  /** Deletes the node and what is inside it, in live: one Trash entry. */
  delete(
    target: TreeWriteTarget,
    input: { node: string; kind: "file" | "folder"; fromSourceId: string; onlyAt?: string },
  ): Promise<Result<DeletedNode, AdapterFault>>;
  /**
   * A tree of new nodes under `dir`, made as one change (a Copy's result, minted before it is
   * written): folders before what they hold, children in the order given. Each root must find
   * its name free in the folder, else the answer is `replan` and nothing is made.
   */
  insertTree(
    target: TreeWriteTarget,
    input: {
      dir: readonly string[];
      roots: readonly NewNode[];
      position?: ContextSiblingPosition;
    },
  ): Promise<Result<{ kind: "inserted" } | { kind: "replan" }, AdapterFault>>;
  /**
   * One tree command on this source's list: `make` runs under the list's lock on the copy at the
   * journal's head, makes whatever records it decides on and returns what it made. It decides
   * before it writes: a throw stores nothing.
   */
  run<T>(target: TreeWriteTarget, make: (scope: TreeScope) => T): Promise<T>;
  /** What this source's tree shows in `view`, at the journal's head. */
  read<T>(view: View, read: (scope: Pick<TreeScope, "writer" | "root" | "view">) => T): Promise<T>;
  /** Ends a drafted create's pending records, for a create whose write failed. */
  discardDraftedCreate(
    target: TreeWriteTarget & { view: { draft: string } },
    node: string,
  ): Promise<void>;
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
        const parent = ensureFolders(writer, target, sourceId, input.dir);
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

    async find(target, dir, filename) {
      const sourceId = await deps.sourceId();
      return deps.store.read({
        lists: [await list()],
        view: ([{ writer }]) => {
          const projection = writer.view(target.view);
          const parent = findFolder(projection, sourceId, dir);
          const found = parent === null ? undefined : childNamed(projection, parent, filename);
          return found ? { id: found.id, kind: found.kind } : null;
        },
      });
    },

    async moveAcrossLists(target, input) {
      const sourceId = await deps.sourceId();
      const here = await list();
      const from = await treeListOfSource(deps.db, input.fromSourceId);
      if (JSON.stringify(from) === JSON.stringify(here))
        return Err({
          code: "invalid_operation",
          message: "A move inside one list is a tree command, not a move between lists",
        } as AdapterFault);
      if (target.view.draft !== null)
        return Err({
          code: "invalid_operation",
          message:
            "A change in a Work's draft cannot move between a project's files and the account's files",
        } as AdapterFault);
      return write<MovedAcrossLists>([here, from], ([dest, origin = dest]) => {
        const { writer } = dest;
        const node = origin.writer.view(LIVE).nodes.get(input.node);
        if (!node || node.trashed || node.purged) return Err({ code: "not_found" } as AdapterFault);
        if (node.kind === "folder")
          return Err({
            code: "invalid_operation",
            message:
              "A folder cannot move between a project's files and the account's files; only documents and files do",
          } as AdapterFault);
        if (node.source !== input.fromSourceId)
          return Err({ code: "stale_source" } as AdapterFault);
        if (
          input.onlyAt !== undefined &&
          pathOf(origin.writer.view(LIVE), node.id).join("/") !== input.onlyAt
        )
          return Err({ code: "stale_target" } as AdapterFault);
        const parent = ensureFolders(writer, target, sourceId, input.dir);
        if (!parent.ok) return parent;
        const projection = writer.view(LIVE);

        // The name the node lands under: the writer's typed one through the name codec, else its own.
        let filename = node.displayName;
        let filetype: Filetype | null = null;
        if (input.leaf !== undefined) {
          const parsed = storedFilename(input.leaf, {
            extension: extensionOf(node),
            editable: node.kind === "document",
          });
          if (!parsed.ok) return Err(parsed.error);
          filename = parsed.name;
          filetype = parsed.filename.filetype;
          const refused = typeConversion(node, filename, filetype);
          if (refused) return Err(refused);
        }
        const occupant = childNamed(projection, parent.value, filename);
        if (occupant) return Err(conflict(occupantKindOf(occupant)));

        const moved = moveBetweenLists(
          origin,
          {
            ...dest,
            parent: parent.value,
            index: indexAt(projection, parent.value, input.position),
            ...(filename !== node.displayName ? { name: filename } : {}),
            ...(filetype && filetype !== node.filetype ? { filetype } : {}),
          },
          target.actor,
          node.id,
        );
        return Ok({ ...moved, path: pathOf(writer.view(LIVE), node.id) });
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
      const result = await write<{ kind: "inserted" } | { kind: "replan" }>(
        [await list()],
        ([{ writer }]) => {
          const parent = ensureFolders(writer, target, sourceId, input.dir);
          if (!parent.ok) return parent;
          const projection = writer.view(target.view);
          if (input.roots.some((root) => childNamed(projection, parent.value, root.filename)))
            return Ok({ kind: "replan" as const });
          // Ranks are minted once per level: a create's own replay per node would cost a
          // replay of the whole list each.
          const at = indexAt(projection, parent.value, input.position);
          const siblings = childrenOf(projection, parent.value);
          const rootRanks = generateNKeysBetween(
            siblings[at - 1]?.rank ?? null,
            siblings[at]?.rank ?? null,
            input.roots.length,
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
          for (const [index, root] of input.roots.entries())
            put(root, parent.value, rootRanks[index] as string);
          return Ok({ kind: "inserted" as const });
        },
      );
      if (result.ok && result.value.kind === "inserted") await annotateTree(input.roots);
      return result;
    },

    async run(target, make) {
      const root = sourceRoot(await deps.sourceId());
      const { result } = await deps.store.submit({
        lists: [await list()],
        make: ([{ writer }]) => make({ writer, view: target.view, actor: target.actor, root }),
      });
      return result;
    },

    async read(view, read) {
      const root = sourceRoot(await deps.sourceId());
      return deps.store.read({
        lists: [await list()],
        view: ([{ writer }]) => read({ writer, view, root }),
      });
    },

    async discardDraftedCreate(target, node) {
      await deps.store.submit({
        lists: [await list()],
        make: ([{ writer }]) => {
          const ids = pendingRecords(writer.doc, target.view.draft)
            .filter((record) => record.node === node)
            .map((record) => record.id);
          writer.transact(() => writer.settle(target.actor, ids, "discarded"));
        },
      });
    },
  };
}
