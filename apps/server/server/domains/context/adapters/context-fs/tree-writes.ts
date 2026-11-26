import type { DocumentId, DraftId } from "@meridian/contracts";
import type { ContextSiblingPosition, Filetype } from "@meridian/contracts/protocol";
import { childAtSegment, readSegment } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import {
  type Actor,
  type BlobRef,
  childrenOf,
  isSourceRoot,
  LIVE,
  segmentOf,
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

export function actorOf(origin: WriteProvenance | undefined): Actor {
  if (origin?.type === "agent") return `agent:${origin.threadId}/${origin.turnId}`;
  if (origin?.type === "human") return `user:${origin.userId}`;
  return "system";
}

export function parseActor(
  actor: string | null | undefined,
): { kind: "user"; userId: string } | { kind: "agent"; chatId: string } | null {
  if (actor?.startsWith("user:")) return { kind: "user", userId: actor.slice("user:".length) };
  if (actor?.startsWith("agent:"))
    return { kind: "agent", chatId: actor.slice("agent:".length).split("/")[0] ?? "" };
  return null;
}

export function viewOfDraft(draftId: DraftId | null): View {
  return draftId === null ? LIVE : { draft: draftId };
}

export type TreeWriteTarget = { view: View; actor: Actor };

function childNamed(
  projection: TreeProjection,
  parent: string,
  segment: string,
  level?: "folder",
): TreeNode | undefined {
  return childAtSegment(childrenOf(projection, parent), segment, level);
}

function pathOf(projection: TreeProjection, id: string): string[] {
  const names: string[] = [];
  for (
    let node = projection.nodes.get(id);
    node;
    node = isSourceRoot(node.parent) ? undefined : projection.nodes.get(node.parent)
  )
    names.unshift(segmentOf(node));
  return names;
}

function ensureFolders(
  writer: TreeWriter,
  target: TreeWriteTarget,
  dir: readonly string[],
  from: string,
  made: MadeFolder[] = [],
): string {
  let parent = from;
  for (const segment of dir) {
    const existing = childNamed(writer.view(target.view), parent, segment, "folder");
    if (existing) {
      parent = existing.id;
      continue;
    }
    const created = writer.create(target.view, target.actor, {
      kind: "folder",
      name: readSegment(segment).name,
      parent,
    });
    made.push({ record: created.id, node: created.node });
    parent = created.node;
  }
  return parent;
}

function findFolder(
  projection: TreeProjection,
  sourceId: string,
  dir: readonly string[],
): string | null {
  let parent = sourceRoot(sourceId);
  for (const segment of dir) {
    const existing = childNamed(projection, parent, segment, "folder");
    if (!existing) return null;
    parent = existing.id;
  }
  return parent;
}

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

export type MadeFolder = { record: string; node: string };

export type CreatedNode = {
  id: string;
  record: string;
  folders: MadeFolder[];
  name: string;
  path: string[];
};

export type InsertedTrees = { landed: ReadonlyMap<string, string>; folders: string[] };

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
  sourceId(): Promise<string>;
  create(
    target: TreeWriteTarget,
    input: {
      dir: readonly string[];
      filename: string;
      kind: "document" | "file";
      filetype?: Filetype;
      blob?: BlobRef;
      id?: string;
      into?: string;
      provisional?: boolean;
      position?: ContextSiblingPosition;
      metadata?: DocumentCreationMetadata;
      hasPreview?: boolean;
    },
  ): Promise<Result<CreatedNode, AdapterFault>>;
  find(
    target: TreeWriteTarget,
    dir: readonly string[],
    filename: string,
    into?: string,
  ): Promise<{ id: string; kind: "document" | "file" | "folder"; path: string } | null>;
  insertTree(
    target: TreeWriteTarget,
    input: {
      trees: readonly {
        dir: readonly string[];
        parent?: { folderId: string; createFolders: readonly string[] };
        roots: readonly NewNode[];
      }[];
      position?: ContextSiblingPosition;
    },
  ): Promise<Result<InsertedTrees, AdapterFault>>;
  /**
   * One tree command on this source's list: `make` runs under the list's lock on a copy of the list as
   * it stands, makes whatever records it decides on and returns its answer. A refused answer
   * stores nothing: what `make` wrote before it refused is dropped with the copy, as a throw does.
   */
  run<T>(
    target: TreeWriteTarget,
    make: (scope: TreeScope) => { result: T; refused?: boolean },
  ): Promise<T>;
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
            : input.into;
        const index = indexAt(writer.view(target.view), parent, input.position);
        const created = writer.create(target.view, target.actor, {
          kind: input.kind,
          name: input.filename,
          parent,
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
          name: shown.nodes.get(created.node)?.name ?? input.filename,
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

    async find(target, dir, leaf, into) {
      const sourceId = await deps.sourceId();
      return deps.store.read({
        lists: [await list()],
        view: ([{ writer }]) => {
          const projection = writer.view(target.view);
          const parent = into ?? findFolder(projection, sourceId, dir);
          const found = parent === null ? undefined : childNamed(projection, parent, leaf);
          return found
            ? { id: found.id, kind: found.kind, path: pathOf(projection, found.id).join("/") }
            : null;
        },
      });
    },

    async insertTree(target, input) {
      const sourceId = await deps.sourceId();
      const result = await write<InsertedTrees>([await list()], ([{ writer }]) => {
        const made: MadeFolder[] = [];
        const groups = input.trees.map((tree) => ({
          roots: tree.roots,
          parent: tree.parent
            ? ensureFolders(writer, target, tree.parent.createFolders, tree.parent.folderId, made)
            : ensureFolders(writer, target, tree.dir, sourceRoot(sourceId), made),
        }));
        const ids: string[] = [];
        for (const group of groups) {
          const projection = writer.view(target.view);
          const at = indexAt(projection, group.parent, input.position);
          const siblings = childrenOf(projection, group.parent);
          const rootRanks = generateNKeysBetween(
            siblings[at - 1]?.rank ?? null,
            siblings[at]?.rank ?? null,
            group.roots.length,
          );
          const put = (node: NewNode, parentId: string, rank: string) => {
            ids.push(node.id);
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
        const landed = writer.view(target.view);
        return Ok({
          landed: new Map(ids.map((id) => [id, pathOf(landed, id).join("/")])),
          folders: made.map((folder) => folder.node),
        });
      });
      if (result.ok) await annotateTree(input.trees.flatMap((tree) => [...tree.roots]));
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
