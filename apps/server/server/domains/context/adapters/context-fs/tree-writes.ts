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
import type { BranchId, BranchTreeFacts, DocumentId, TreePlacement } from "@meridian/contracts";
import {
  type ContextSiblingPosition,
  classifyFiletype,
  type Filetype,
  parseDocumentFilename,
  storedFilename,
} from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import {
  type Actor,
  type BlobRef,
  childrenOf,
  descendantsOf,
  isSourceRoot,
  LIVE,
  pendingRecords,
  sourceRoot,
  type TreeNode,
  type TreeProjection,
  type TreeRecord,
  type TreeWriter,
  type View,
} from "@meridian/project-tree";
import { eq } from "drizzle-orm";
import { generateNKeysBetween } from "fractional-indexing";
import { currentDrizzleDb } from "../../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type { DocumentCreationMetadata } from "../../document-metadata.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import type { WriteProvenance } from "../../ports/context-port.js";
import type { TreeListStore } from "../../ports/tree-list-store.js";
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
 * refuses with the occupant's kind. `made` collects the records that create new nodes.
 */
function ensureFolders(
  writer: TreeWriter,
  target: TreeWriteTarget,
  sourceId: string,
  dir: readonly string[],
  made: TreeRecord[],
): Result<string, AdapterFault> {
  let parent = sourceRoot(sourceId);
  for (const name of dir) {
    const existing = childNamed(writer.view(target.view), parent, name);
    if (existing) {
      if (existing.kind !== "folder") return Err(conflict("file"));
      parent = existing.id;
      continue;
    }
    const created = writer.create(target.view, target.actor, { kind: "folder", name, parent });
    made.push(created);
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

function placementOf(node: TreeNode): TreePlacement {
  const parsed = node.kind === "folder" ? null : parseDocumentFilename(node.displayName);
  const parts = parsed?.ok
    ? { name: parsed.value.name, extension: parsed.value.extension }
    : { name: node.displayName, extension: "" };
  const top = isSourceRoot(node.parent);
  return {
    folderId: top ? null : node.parent,
    rootSourceId: top ? node.source : null,
    ...parts,
    rank: node.rank,
  };
}

/**
 * What a Work's view says about a node beside live's: a row only where it differs, created
 * where live has none. The edit history records this before and after each drafted tree call.
 */
export function branchFacts(
  live: TreeProjection,
  draft: TreeProjection,
  node: string,
): BranchTreeFacts {
  const base = live.nodes.get(node);
  const shown = draft.nodes.get(node);
  if (!shown) return { row: false, created: false, moved: null, deleted: false };
  if (!base) return { row: true, created: true, moved: null, deleted: shown.trashed };
  const moved =
    base.parent !== shown.parent ||
    base.displayName !== shown.displayName ||
    base.rank !== shown.rank;
  return {
    row: moved || shown.trashed !== base.trashed,
    created: false,
    moved: moved ? placementOf(shown) : null,
    deleted: shown.trashed && !base.trashed,
  };
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

export type CreatedNode = { id: string; name: string; path: string[] };

export type MovedNode = {
  moved: boolean;
  path: string[];
  /** The node's facts in a Work's view before and after, for the edit history. */
  facts?: { before: BranchTreeFacts; after: BranchTreeFacts };
};

export type DeletedNode = {
  /** The documents and files the delete took, the node itself among them. */
  documentIds: string[];
  path: string[];
  facts?: { before: BranchTreeFacts; after: BranchTreeFacts };
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
   * Moves (and renames) the node into `dir` of this source. The node is found by id in the
   * view; `leaf` is the name the writer typed, else the node keeps its own.
   */
  move(
    target: TreeWriteTarget,
    input: {
      node: string;
      kind: "file" | "folder";
      /** The source the caller found it in: a node found elsewhere is `stale_source`. */
      fromSourceId: string;
      /** The folder it lands in, below this source's top; null keeps the node's own folder. */
      dir: readonly string[] | null;
      leaf?: string;
      position?: ContextSiblingPosition;
      /** Delete or move only while the node stands at this source-relative path. */
      onlyAt?: string;
    },
  ): Promise<Result<MovedNode, AdapterFault>>;
  /** Deletes the node and what is inside it: one Trash entry. */
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
  /** Ends a drafted create's pending records, for a create whose write failed. */
  discardDraftedCreate(
    target: TreeWriteTarget & { view: { draft: string } },
    node: string,
  ): Promise<void>;
}

export function createSourceTree(deps: {
  store: Pick<TreeListStore, "submit">;
  db: Database;
  sourceId(): Promise<string>;
}): SourceTree {
  const list = async () => treeListOfSource(deps.db, await deps.sourceId());

  /** The Work's view beside live, when the view is a Work's. */
  const factsOf = (writer: TreeWriter, view: View, node: string) =>
    view.draft === null ? null : branchFacts(writer.view(LIVE), writer.view(view), node);

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
      const { result } = await deps.store.submit<Result<CreatedNode, AdapterFault>>({
        list: await list(),
        make: (writer) => {
          const made: TreeRecord[] = [];
          const parent = ensureFolders(writer, target, sourceId, input.dir, made);
          if (!parent.ok) return { records: [], result: parent };
          const occupant = childNamed(writer.view(target.view), parent.value, input.filename);
          if (occupant) return { records: [], result: Err(conflict(occupantKindOf(occupant))) };
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
          made.push(created);
          const shown = writer.view(target.view);
          return {
            records: made,
            result: Ok({
              id: created.node,
              name: shown.nodes.get(created.node)?.displayName ?? input.filename,
              path: pathOf(shown, created.node),
            }),
          };
        },
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
      const { result } = await deps.store.submit<{
        id: string;
        kind: "document" | "file" | "folder";
      } | null>({
        list: await list(),
        make: (writer) => {
          const projection = writer.view(target.view);
          const parent = findFolder(projection, sourceId, dir);
          const found = parent === null ? undefined : childNamed(projection, parent, filename);
          return { records: [], result: found ? { id: found.id, kind: found.kind } : null };
        },
      });
      return result;
    },

    async move(target, input) {
      const sourceId = await deps.sourceId();
      const here = await list();
      const from = await treeListOfSource(deps.db, input.fromSourceId);
      if (JSON.stringify(from) !== JSON.stringify(here))
        return Err({
          code: "invalid_operation",
          message: "A move between a project's files and the account's files is not available",
        });
      const { result } = await deps.store.submit<Result<MovedNode, AdapterFault>>({
        list: here,
        make: (writer) => {
          const projection = writer.view(target.view);
          const node = projection.nodes.get(input.node);
          const wanted = input.kind === "folder" ? "folder" : undefined;
          if (!node || node.trashed || node.purged || (wanted && node.kind !== wanted))
            return { records: [], result: Err({ code: "not_found" } as AdapterFault) };
          if ((input.kind === "file") !== (node.kind !== "folder"))
            return { records: [], result: Err({ code: "not_found" } as AdapterFault) };
          if (node.source !== input.fromSourceId)
            return { records: [], result: Err({ code: "stale_source" } as AdapterFault) };
          if (input.onlyAt !== undefined && pathOf(projection, node.id).join("/") !== input.onlyAt)
            return { records: [], result: Err({ code: "stale_target" } as AdapterFault) };
          const parent =
            input.dir === null ? node.parent : findFolder(projection, sourceId, input.dir);
          if (parent === null)
            return { records: [], result: Err({ code: "destination_missing" } as AdapterFault) };
          if (
            node.kind === "folder" &&
            (parent === node.id || descendantsOf(projection, node.id).includes(parent))
          )
            return { records: [], result: Err({ code: "invalid_operation" } as AdapterFault) };

          // The name the node lands under: the writer's typed one through the name codec, else its own.
          let filename = node.displayName;
          let filetype: Filetype | null = null;
          if (input.leaf !== undefined) {
            if (node.kind === "folder") filename = input.leaf;
            else {
              const parsed = storedFilename(input.leaf, {
                extension: extensionOf(node),
                editable: node.kind === "document",
              });
              if (!parsed.ok) return { records: [], result: Err(parsed.error) };
              filename = parsed.name;
              filetype = parsed.filename.filetype;
              const refused = typeConversion(node, filename, filetype);
              if (refused) return { records: [], result: Err(refused) };
            }
          }
          const occupant = childNamed(projection, parent, filename);
          if (occupant && occupant.id !== node.id)
            return { records: [], result: Err(conflict(occupantKindOf(occupant))) };

          const sameParent = node.parent === parent;
          const renamed = filename !== node.displayName;
          if (sameParent && !renamed && !input.position)
            return { records: [], result: Ok({ moved: false, path: pathOf(projection, node.id) }) };

          const before = factsOf(writer, target.view, node.id);
          if (!sameParent || input.position)
            writer.move(
              target.view,
              target.actor,
              node.id,
              parent,
              indexAt(projection, parent, input.position, node.id),
            );
          if (renamed)
            writer.rename(
              target.view,
              target.actor,
              node.id,
              filename,
              filetype && filetype !== node.filetype ? filetype : undefined,
            );
          const after = factsOf(writer, target.view, node.id);
          return {
            records: [],
            result: Ok({
              moved: true,
              path: pathOf(writer.view(target.view), node.id),
              ...(before && after ? { facts: { before, after } } : {}),
            }),
          };
        },
      });
      return result;
    },

    async delete(target, input) {
      const { result } = await deps.store.submit<Result<DeletedNode, AdapterFault>>({
        list: await list(),
        make: (writer) => {
          const projection = writer.view(target.view);
          const node = projection.nodes.get(input.node);
          if (!node || node.trashed || node.purged)
            return { records: [], result: Err({ code: "not_found" } as AdapterFault) };
          if ((input.kind === "file") !== (node.kind !== "folder"))
            return { records: [], result: Err({ code: "not_found" } as AdapterFault) };
          if (node.source !== input.fromSourceId)
            return { records: [], result: Err({ code: "stale_source" } as AdapterFault) };
          const path = pathOf(projection, node.id);
          if (input.onlyAt !== undefined && path.join("/") !== input.onlyAt)
            return { records: [], result: Err({ code: "stale_target" } as AdapterFault) };
          const before = factsOf(writer, target.view, node.id);
          const record = writer.delete(target.view, target.actor, node.id);
          const taken = [node.id, ...record.cascade].flatMap((id) => {
            const taken = projection.nodes.get(id);
            return taken && taken.kind !== "folder" ? [id] : [];
          });
          const after = factsOf(writer, target.view, node.id);
          return {
            records: [],
            result: Ok({
              documentIds: taken,
              path,
              ...(before && after ? { facts: { before, after } } : {}),
            }),
          };
        },
      });
      return result;
    },

    async insertTree(target, input) {
      const sourceId = await deps.sourceId();
      const { result } = await deps.store.submit<
        Result<{ kind: "inserted" } | { kind: "replan" }, AdapterFault>
      >({
        list: await list(),
        make: (writer) => {
          const made: TreeRecord[] = [];
          const parent = ensureFolders(writer, target, sourceId, input.dir, made);
          if (!parent.ok) return { records: [], result: parent };
          const projection = writer.view(target.view);
          if (input.roots.some((root) => childNamed(projection, parent.value, root.filename)))
            return { records: [], result: Ok({ kind: "replan" as const }) };
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
            const base = {
              node: node.id,
              name: node.filename,
              parent: parentId,
              source: sourceId,
              rank,
            };
            const record = writer.prepare(target.view, target.actor, {
              type: "create",
              kind: node.kind,
              ...base,
              ...(node.kind === "document" ? { filetype: node.filetype } : {}),
              ...(node.kind === "file" ? { blob: node.blob } : {}),
            }) as TreeRecord;
            writer.append(record);
            made.push(record);
            if (node.kind !== "folder") return;
            const ranks = generateNKeysBetween(null, null, node.children.length);
            for (const [index, child] of node.children.entries())
              put(child, node.id, ranks[index] as string);
          };
          for (const [index, root] of input.roots.entries())
            put(root, parent.value, rootRanks[index] as string);
          return { records: made, result: Ok({ kind: "inserted" as const }) };
        },
      });
      if (result.ok && result.value.kind === "inserted") await annotateTree(input.roots);
      return result;
    },

    async discardDraftedCreate(target, node) {
      await deps.store.submit({
        list: await list(),
        make: (writer) => {
          const ids = pendingRecords(writer.doc, target.view.draft)
            .filter((record) => record.node === node)
            .map((record) => record.id);
          writer.transact(() => writer.settle(target.actor, ids, "discarded"));
          return { records: [], result: undefined };
        },
      });
    },
  };
}
