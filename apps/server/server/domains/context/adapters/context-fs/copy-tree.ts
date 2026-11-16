import type { BranchId } from "@meridian/contracts";
/**
 * Copy's destination half in one ContextFS source: naming and identity, planned without a
 * lock, and the insertion of a plan inside the caller's command transaction.
 *
 * Names are this namespace's, so allocation happens here, against the shown occupants and the
 * rest of the batch. Only the roots meet occupants that already exist: a copied folder is new,
 * so nothing can sit inside it, and the batch's own names are its whole namespace. Planning
 * therefore reads the destination parent once and holds nothing; the insert is one `submit`
 * on the list, which checks under the list's lock that every root's name is still free and
 * answers `replan` instead of inserting when a concurrent write took one.
 *
 * A copied folder is inserted before its children, and the children take ranks in source
 * order, so the copy reproduces the source's visible order. Two passes, because a link may cross
 * roots: the plan mints every identity first (a selected root takes the device's id when it
 * sent one), and the caller binds each document against the whole old→new map before anything
 * is written.
 */

import type { DocumentId } from "@meridian/contracts";
import {
  type ContextSiblingPosition,
  firstFreeName,
  renderFilename,
} from "@meridian/contracts/protocol";
import { LIVE } from "@meridian/project-tree";
import { runAfterDrizzleCommit } from "../../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import {
  type CollabDomain,
  createCopyIdentityMap,
  type DocumentCreationAggregate,
  type DraftPeerShadowAccess,
} from "../../../collab/index.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import type {
  CopiedContent,
  CopyCreatedEntry,
  CopyOutcome,
  CopyPlan,
  CopySourceEntry,
  PlannedCopyFile,
  PlannedCopyNode,
} from "../../ports/context-copy.js";
import type { ContextDocumentStore } from "../../ports/context-document-store.js";
import type { DocumentArrivals } from "../../ports/document-arrivals.js";
import type { TreeView } from "../../tree/tree-view.js";
import { NodeIdRefusedError } from "../tree-list-rows.js";
import { type NewNode, type SourceTree, viewOfBranch } from "./tree-writes.js";

export interface CopyTreeDeps {
  store: ContextDocumentStore;
  writes: SourceTree;
  documentCreation: Pick<DocumentCreationAggregate, "createDocumentsAtomically">;
  documentSync: Pick<CollabDomain, "installSeeds" | "refreshDocumentProjection">;
  arrivals?: Pick<DocumentArrivals, "lockNamespaces" | "settle">;
  /** Who made the copy: `user:<id>`. */
  actor: string;
  /** The canonical address of a document at a scheme-relative path in this source. */
  holderUri(path: string): string;
  /** A folder's address: its name as stored, never the document alias (folder `Lore.md` is not `Lore`). */
  folderUri(path: string): string;
}

/** Plan `roots` under `dir`: read the destination parent, write nothing, hold no lock. */
export async function planCopyTree(
  deps: CopyTreeDeps,
  input: { dir: readonly string[]; roots: readonly CopySourceEntry[]; view: TreeView },
): Promise<CopyPlan> {
  const parent = await findDestinationParent(deps, input.dir, input.view);
  const planned = await planLevel(
    deps,
    [...input.dir],
    parent.found ? await deps.store.namesAt(input.view, parent.id) : new Set(),
    input.roots,
  );
  return treePlan(input.dir, planned);
}

export function treePlan(dir: readonly string[], planned: readonly PlannedCopyNode[]): CopyPlan {
  const nodes = flatten(planned);
  const identity = createCopyIdentityMap({
    // Binaries are in the map too: an image inside the copied set must show its copy.
    documents: nodes.flatMap((node) =>
      node.kind === "file"
        ? [
            {
              sourceDocumentId: node.source.documentId,
              sourceUri: node.source.uri,
              documentId: node.id,
              uri: node.uri,
            },
          ]
        : [],
    ),
    folders: nodes.flatMap((node) =>
      node.kind === "folder"
        ? [
            {
              sourceFolderId: node.source.folderId,
              sourceUri: node.source.uri,
              folderId: node.id,
              uri: node.uri,
            },
          ]
        : [],
    ),
  });
  return {
    dir,
    roots: planned,
    map: identity,
    documents: nodes.filter(
      (node): node is PlannedCopyFile => node.kind === "file" && node.source.fileType === null,
    ),
  };
}

export async function insertPlannedTrees(
  deps: CopyTreeDeps,
  inputs: readonly {
    plan: CopyPlan;
    contents: ReadonlyMap<string, CopiedContent>;
    /** The folder to start from, by id, instead of walking the plan's `dir` by name. */
    parent?: { folderId: string; createFolders: readonly string[] };
  }[],
  position?: ContextSiblingPosition,
  draft?: {
    branchId: BranchId;
    documentSync: Pick<DraftPeerShadowAccess, "writeCreatedDraftContent">;
  },
): Promise<Result<CopyOutcome, AdapterFault>> {
  if (draft) {
    const { branchId } = draft;
    const { plan, contents, parent } = inputs[0];
    const tree = toNewTree(plan.roots, contents);
    if (!tree.ok) return tree;
    try {
      const inserted = await deps.writes.insertTree(
        { view: viewOfBranch(branchId), actor: deps.actor },
        {
          trees: [{ dir: plan.dir, ...(parent ? { parent } : {}), roots: tree.value.roots }],
          ...(position ? { position: position } : {}),
        },
      );
      if (!inserted.ok) return inserted;
      if (inserted.value.kind === "replan") return Ok({ kind: "replan" });
      await draft.documentSync.writeCreatedDraftContent(
        [...tree.value.contents].flatMap(([documentId, content]) =>
          content.content
            ? [
                {
                  documentId: documentId as DocumentId,
                  branchId: branchId as BranchId,
                  content: content.content,
                },
              ]
            : [],
        ),
      );
      return Ok({
        kind: "copied",
        entries: entriesOf(plan.roots),
        folders: inserted.value.folders,
      });
    } catch (error) {
      if (error instanceof NodeIdRefusedError) return Err({ code: "conflict" });
      throw error;
    }
  }
  const trees: {
    dir: readonly string[];
    parent?: { folderId: string; createFolders: readonly string[] };
    roots: readonly NewNode[];
  }[] = [];
  const states = new Map<string, Uint8Array | null>();
  const ids: string[] = [];
  const binaryIds: string[] = [];
  const documents = inputs.flatMap(({ plan }) => [...plan.documents]);
  for (const { plan, contents, parent } of inputs) {
    const tree = toNewTree(plan.roots, contents);
    if (!tree.ok) return tree;
    trees.push({ dir: plan.dir, ...(parent ? { parent } : {}), roots: tree.value.roots });
    for (const [id, content] of tree.value.contents) states.set(id, content.state);
    ids.push(...tree.value.ids);
    binaryIds.push(...tree.value.binaryIds);
  }
  let refusal: AdapterFault | null = null;
  let replan = false;
  let folders: string[] = [];
  // Rows, then each tracked document's first state, then its arrival: one unit.
  let created: Awaited<ReturnType<DocumentCreationAggregate["createDocumentsAtomically"]>>;
  try {
    created = await deps.documentCreation.createDocumentsAtomically({
      persistIdentities: async () => {
        const inserted = await deps.writes.insertTree(
          { view: LIVE, actor: deps.actor },
          {
            trees,
            ...(position ? { position } : {}),
          },
        );
        if (!inserted.ok) {
          refusal = inserted.error;
          return null;
        }
        if (inserted.value.kind === "replan") {
          replan = true;
          return null;
        }
        folders = inserted.value.folders;
        // Arrivals settle ahead refs under the source's namespace key, taken after the list's.
        await deps.arrivals?.lockNamespaces(ids as DocumentId[], [
          (await deps.writes.sourceId()) as never,
        ]);
        return documents.map((document) => document.id as DocumentId);
      },
      initializeContent: (documentIds) =>
        deps.documentSync.installSeeds(
          documentIds.map((documentId) => ({
            documentId,
            state: states.get(documentId) ?? null,
          })),
        ),
    });
  } catch (error) {
    // A node id the device minted is in use: the same drop sent twice, or a stray id.
    if (error instanceof NodeIdRefusedError) return Err({ code: "conflict" });
    throw error;
  }
  if (refusal) return Err(refusal);
  if (replan || !created.created) return Ok({ kind: "replan" });
  // An upload's arrival publishes with its live identity; a tracked document's waited for its
  // content, in the creation aggregate.
  await deps.arrivals?.settle(binaryIds as DocumentId[]);
  // Projections read committed rows and need no namespace lock. Match Copy's bounded fan-out.
  runAfterDrizzleCommit(() => {
    const queue = documents.map((document) => document.id as DocumentId);
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift())
        await deps.documentSync.refreshDocumentProjection({ documentId: id });
    };
    void Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  });
  return Ok({
    kind: "copied",
    entries: inputs.flatMap(({ plan }) => entriesOf(plan.roots)),
    folders,
  });
}

/**
 * The plan as the nodes to insert, with each tracked document's first state by new id. A
 * binary's node points at the object the copy duplicated before this transaction.
 */
function toNewTree(
  roots: readonly PlannedCopyNode[],
  contents: ReadonlyMap<string, CopiedContent>,
): Result<
  {
    roots: NewNode[];
    contents: Map<string, CopiedContent>;
    ids: string[];
    binaryIds: string[];
  },
  AdapterFault
> {
  const contentsById = new Map<string, CopiedContent>();
  const ids: string[] = [];
  const binaryIds: string[] = [];
  const convert = (node: PlannedCopyNode): Result<NewNode, AdapterFault> => {
    ids.push(node.id);
    if (node.kind === "folder") {
      const children: NewNode[] = [];
      for (const child of node.children) {
        const converted = convert(child);
        if (!converted.ok) return converted;
        children.push(converted.value);
      }
      return Ok({ kind: "folder", id: node.id, filename: node.name, children });
    }
    const { source } = node;
    const filename = renderFilename(node.name, node.extension);
    if (source.fileType !== null) {
      if (!source.storageUrl || !source.mimeType) {
        return Err({
          code: "io_error",
          message: `Copied binary ${source.path} has no stored object or MIME type`,
        });
      }
      binaryIds.push(node.id);
      return Ok({
        kind: "file",
        id: node.id,
        filename,
        blob: {
          storageKey: source.storageUrl,
          mime: source.mimeType,
          size: source.sizeBytes ?? 0,
        },
        hasPreview: source.hasPreview,
        // A binary has no drafts or revisions, so its copy always records the live file.
        metadata: { copiedFrom: { uri: source.uri, version: "live", revision: null } },
      });
    }
    const content = contents.get(source.documentId);
    if (!content) throw new Error(`No content was bound for ${source.path}`);
    contentsById.set(node.id, content);
    return Ok({
      kind: "document",
      id: node.id,
      filename,
      filetype: source.filetype,
      ...(content.copiedFrom ? { metadata: { copiedFrom: content.copiedFrom } } : {}),
    });
  };
  const converted: NewNode[] = [];
  for (const root of roots) {
    const node = convert(root);
    if (!node.ok) return node;
    converted.push(node.value);
  }
  return Ok({ roots: converted, contents: contentsById, ids, binaryIds });
}

/** The identities a copy created, each folder before what it holds. */
function entriesOf(nodes: readonly PlannedCopyNode[]): CopyCreatedEntry[] {
  return nodes.flatMap((node): CopyCreatedEntry[] =>
    node.kind === "folder"
      ? [
          {
            kind: "folder",
            id: node.id,
            path: node.path,
            name: node.name,
            copiedFrom: node.source.folderId,
          },
          ...entriesOf(node.children),
        ]
      : [
          {
            kind: "file",
            id: node.id,
            path: node.path,
            name: renderFilename(node.name, node.extension),
            copiedFrom: node.source.documentId,
          },
        ],
  );
}

function flatten(nodes: readonly PlannedCopyNode[]): PlannedCopyNode[] {
  return nodes.flatMap((node) =>
    node.kind === "folder" ? [node, ...flatten(node.children)] : [node],
  );
}

/** The destination parent as it is now, without making it. */
async function findDestinationParent(
  deps: CopyTreeDeps,
  dir: readonly string[],
  view: TreeView,
): Promise<{ found: true; id: string | null } | { found: false }> {
  if (dir.length === 0) return { found: true, id: null };
  const folder = await deps.store.resolveFolderAt(view, dir.join("/"));
  return folder.kind === "found" && folder.node
    ? { found: true, id: folder.node.id }
    : { found: false };
}

/** Allocate every name and mint every identity, parents before their children. */
async function planLevel(
  deps: CopyTreeDeps,
  dir: readonly string[],
  taken: Set<string>,
  sources: readonly CopySourceEntry[],
): Promise<PlannedCopyNode[]> {
  const planned: PlannedCopyNode[] = [];
  for (const source of sources) {
    const free = firstFreeName(
      { name: source.name, extension: source.kind === "folder" ? "" : source.extension },
      taken,
    );
    const { filename } = free;
    const path = [...dir, filename].join("/");
    taken.add(filename);
    if (source.kind === "folder") {
      planned.push({
        kind: "folder",
        source,
        // A selected root may carry the device's id; a folder's children never do.
        id: source.copyId ?? crypto.randomUUID(),
        name: filename,
        path,
        uri: deps.folderUri(path),
        children: await planLevel(deps, [...dir, filename], new Set(), source.children),
      });
      continue;
    }
    planned.push({
      kind: "file",
      source,
      id: source.copyId ?? crypto.randomUUID(),
      name: free.name,
      extension: free.extension,
      path,
      uri: deps.holderUri(path),
    });
  }
  return planned;
}
