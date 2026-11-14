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
import { Err, Ok, type Result } from "../../../../shared/result.js";
import {
  createCopyIdentityMap,
  type DocumentCreationAggregate,
  type MarkdownDocumentStore,
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
import { LIVE_TREE } from "../../tree/tree-view.js";
import { NodeIdRefusedError } from "../tree-list-rows.js";
import type { NewNode, SourceTree } from "./tree-writes.js";

export interface CopyTreeDeps {
  store: ContextDocumentStore;
  writes: SourceTree;
  documentCreation: DocumentCreationAggregate;
  documentSync: Pick<MarkdownDocumentStore, "installSeeds">;
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
  input: { dir: readonly string[]; roots: readonly CopySourceEntry[] },
): Promise<CopyPlan> {
  const parent = await findDestinationParent(deps, input.dir);
  const planned = await planLevel(
    deps,
    [...input.dir],
    parent.found ? await deps.store.namesAt(LIVE_TREE, parent.id) : new Set(),
    input.roots,
  );
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
    dir: input.dir,
    roots: planned,
    map: identity,
    documents: nodes.filter(
      (node): node is PlannedCopyFile => node.kind === "file" && node.source.fileType === null,
    ),
  };
}

export async function insertCopiedTree(
  deps: CopyTreeDeps,
  input: {
    dir: readonly string[];
    plan: CopyPlan;
    contents: ReadonlyMap<string, CopiedContent>;
    position?: ContextSiblingPosition;
  },
): Promise<Result<CopyOutcome, AdapterFault>> {
  const { plan, contents } = input;
  if (plan.dir.join("/") !== input.dir.join("/")) return Ok({ kind: "replan" });
  const tree = toNewTree(plan.roots, contents);
  if (!tree.ok) return tree;
  let refusal: AdapterFault | null = null;
  let replan = false;
  // Rows, then each tracked document's first state, then its arrival: one unit.
  let created: Awaited<ReturnType<DocumentCreationAggregate["createDocumentsAtomically"]>>;
  try {
    created = await deps.documentCreation.createDocumentsAtomically({
      persistIdentities: async () => {
        const inserted = await deps.writes.insertTree(
          { view: LIVE, actor: deps.actor },
          {
            dir: input.dir,
            roots: tree.value.roots,
            ...(input.position ? { position: input.position } : {}),
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
        // Arrivals settle ahead refs under the source's namespace key, taken after the list's.
        await deps.arrivals?.lockNamespaces(tree.value.ids as DocumentId[], [
          (await deps.writes.sourceId()) as never,
        ]);
        return plan.documents.map((document) => document.id as DocumentId);
      },
      initializeContent: (documentIds) =>
        deps.documentSync.installSeeds(
          documentIds.map((documentId) => ({
            documentId,
            state: tree.value.states.get(documentId) ?? null,
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
  await deps.arrivals?.settle(tree.value.binaryIds as DocumentId[]);
  return Ok({ kind: "copied", entries: entriesOf(plan.roots) });
}

/**
 * The plan as the nodes to insert, with each tracked document's first state by new id. A
 * binary's node points at the object the copy duplicated before this transaction.
 */
function toNewTree(
  roots: readonly PlannedCopyNode[],
  contents: ReadonlyMap<string, CopiedContent>,
): Result<
  { roots: NewNode[]; states: Map<string, Uint8Array | null>; ids: string[]; binaryIds: string[] },
  AdapterFault
> {
  const states = new Map<string, Uint8Array | null>();
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
    states.set(node.id, content.state);
    return Ok({
      kind: "document",
      id: node.id,
      filename,
      filetype: source.filetype,
      metadata: { copiedFrom: content.copiedFrom },
    });
  };
  const converted: NewNode[] = [];
  for (const root of roots) {
    const node = convert(root);
    if (!node.ok) return node;
    converted.push(node.value);
  }
  return Ok({ roots: converted, states, ids, binaryIds });
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
): Promise<{ found: true; id: string | null } | { found: false }> {
  if (dir.length === 0) return { found: true, id: null };
  const folder = await deps.store.resolveFolderAt(LIVE_TREE, dir.join("/"));
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
