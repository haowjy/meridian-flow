/**
 * Copy's destination half in one ContextFS source: naming and identity, planned without a
 * lock, and the insertion of a plan inside the caller's command transaction.
 *
 * Names are this namespace's, so allocation happens here, against live occupants and the rest
 * of the batch. A hidden node (a draft's document) never takes a name from a visible one: a root
 * takes its name, and the hidden node yields in the insert (`insertNewTree`). Only the roots meet
 * occupants that already exist: a copied folder is new, so nothing live or hidden can sit
 * inside it, and the batch's own names are its whole namespace. Planning therefore reads the
 * destination parent once and holds nothing; the insert re-reads the parent under the lock
 * and, if the roots would now take other names, answers `replan` instead of inserting.
 *
 * A copied folder is inserted before its children and keeps its source's own ordering policy,
 * so inserting the children in source order reproduces the source's visible order in a manual
 * folder and leaves name order alone in a default one. Two passes, because a link may cross
 * roots: the plan mints every identity first (a selected root takes the device's id when it
 * sent one), and the caller binds each document against the whole old→new map before anything
 * is written.
 */

import type { DocumentId, FolderId } from "@meridian/contracts";
import {
  allocateFilename,
  type ContextSiblingPosition,
  type NamespaceNameClaim,
  renderFilename,
  sameNamespaceName,
} from "@meridian/contracts/protocol";
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
import {
  type ContextDocumentStore,
  ContextEntryConflictError,
} from "../../ports/context-document-store.js";
import type { NewTreeNode } from "../../tree/new-tree.js";
import { LIVE_TREE } from "../../tree/tree-view.js";

export interface CopyTreeDeps {
  store: ContextDocumentStore;
  documentCreation: DocumentCreationAggregate;
  documentSync: Pick<MarkdownDocumentStore, "installSeeds">;
  /** The canonical address of a scheme-relative path in this source. */
  holderUri(path: string): string;
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
    parent.found ? await occupantClaims(deps, parent.id) : [],
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
  const parent = await ensureDestinationParent(deps, input.dir);
  if (!parent.ok) return parent;
  const { plan, contents } = input;
  if (!(await planHolds(deps, input.dir, parent.value, plan))) return Ok({ kind: "replan" });

  const tree = toNewTree(plan.roots, contents);
  if (!tree.ok) return tree;
  let stale = false;
  try {
    // Rows, then each tracked document's first state, then its arrival: one unit.
    await deps.documentCreation.createDocumentsAtomically({
      persistIdentities: async () => {
        const inserted = await deps.store.insertNewTree({
          parentId: parent.value,
          roots: tree.value.roots,
          ...(input.position ? { position: input.position } : {}),
        });
        stale = inserted === "stale-anchor";
        return stale ? null : plan.documents.map((document) => document.id as DocumentId);
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
    if (error instanceof ContextEntryConflictError) {
      return Err({
        code: "conflict",
        ...(error.occupantKind ? { occupantKind: error.occupantKind } : {}),
      });
    }
    throw error;
  }
  if (stale) return Err({ code: "stale_target" });
  return Ok({ kind: "copied", entries: entriesOf(plan.roots) });
}

/**
 * The plan as the rows to insert, with each tracked document's first state by new id. A
 * binary's row points at the object the copy duplicated before this transaction.
 */
function toNewTree(
  roots: readonly PlannedCopyNode[],
  contents: ReadonlyMap<string, CopiedContent>,
): Result<{ roots: NewTreeNode[]; states: Map<string, Uint8Array | null> }, AdapterFault> {
  const states = new Map<string, Uint8Array | null>();
  const convert = (node: PlannedCopyNode): Result<NewTreeNode, AdapterFault> => {
    if (node.kind === "folder") {
      const children: NewTreeNode[] = [];
      for (const child of node.children) {
        const converted = convert(child);
        if (!converted.ok) return converted;
        children.push(converted.value);
      }
      return Ok({
        kind: "folder",
        id: node.id as FolderId,
        name: node.name,
        orderPolicy: node.source.orderPolicy,
        children,
      });
    }
    const row = {
      kind: "document" as const,
      id: node.id as DocumentId,
      name: node.name,
      extension: node.extension,
      path: node.path,
    };
    const { source } = node;
    if (source.fileType !== null) {
      if (!source.storageUrl) {
        return Err({
          code: "io_error",
          message: `Copied binary ${source.path} has no stored object`,
        });
      }
      return Ok({
        ...row,
        node: {
          kind: "binary",
          fileType: source.fileType,
          storageUrl: source.storageUrl,
          // A binary row normally carries its type; an old row that lost it copies as opaque bytes.
          mimeType: source.mimeType ?? "application/octet-stream",
          sizeBytes: source.sizeBytes ?? 0,
          hasPreview: source.hasPreview,
          // A binary has no drafts or revisions, so its copy always records the live file.
          metadata: { copiedFrom: { uri: source.uri, version: "live", revision: null } },
        },
      });
    }
    const content = contents.get(source.documentId);
    if (!content) throw new Error(`No content was bound for ${source.path}`);
    states.set(node.id, content.state);
    return Ok({
      ...row,
      node: {
        kind: "tracked",
        filetype: source.filetype,
        metadata: { copiedFrom: content.copiedFrom },
      },
    });
  };
  const converted: NewTreeNode[] = [];
  for (const root of roots) {
    const node = convert(root);
    if (!node.ok) return node;
    converted.push(node.value);
  }
  return Ok({ roots: converted, states });
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

/**
 * Whether the roots would take the names the plan gave them, against the destination as the
 * caller's lock now holds it. Everything below a root follows from the root's name.
 */
async function planHolds(
  deps: CopyTreeDeps,
  dir: readonly string[],
  parentId: string | null,
  plan: CopyPlan,
): Promise<boolean> {
  if (plan.dir.join("/") !== dir.join("/")) return false;
  const taken = await occupantClaims(deps, parentId);
  for (const root of plan.roots) {
    const filename = await allocateName(root.source, taken);
    if (
      filename !== (root.kind === "folder" ? root.name : renderFilename(root.name, root.extension))
    ) {
      return false;
    }
    taken.push(claimOf(root.source, filename));
  }
  return true;
}

function flatten(nodes: readonly PlannedCopyNode[]): PlannedCopyNode[] {
  return nodes.flatMap((node) =>
    node.kind === "folder" ? [node, ...flatten(node.children)] : [node],
  );
}

async function ensureDestinationParent(
  deps: CopyTreeDeps,
  dir: readonly string[],
): Promise<Result<string | null, AdapterFault>> {
  try {
    return Ok(await deps.store.ensureFolderPath(dir));
  } catch (error) {
    if (error instanceof ContextEntryConflictError) {
      return Err({
        code: "conflict",
        ...(error.occupantKind ? { occupantKind: error.occupantKind } : {}),
      });
    }
    throw error;
  }
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

/** The first free filename for a source among the names already taken. */
function allocateName(source: CopySourceEntry, taken: readonly NamespaceNameClaim[]) {
  return allocateFilename(
    source.kind === "folder"
      ? { kind: "folder", name: source.name }
      : { kind: "document", name: source.name, extension: source.extension },
    (candidate) => taken.some((claim) => sameNamespaceName(candidate, claim)),
  );
}

function claimOf(source: CopySourceEntry, filename: string): NamespaceNameClaim {
  return { kind: source.kind === "folder" ? "folder" : "document", filename };
}

/** Allocate every name and mint every identity, parents before their children. */
async function planLevel(
  deps: CopyTreeDeps,
  dir: readonly string[],
  taken: NamespaceNameClaim[],
  sources: readonly CopySourceEntry[],
): Promise<PlannedCopyNode[]> {
  const planned: PlannedCopyNode[] = [];
  for (const source of sources) {
    const filename = await allocateName(source, taken);
    const path = [...dir, filename].join("/");
    taken.push(claimOf(source, filename));
    if (source.kind === "folder") {
      planned.push({
        kind: "folder",
        source,
        // A selected root may carry the device's id; a folder's children never do.
        id: source.copyId ?? crypto.randomUUID(),
        name: filename,
        path,
        uri: deps.holderUri(path),
        children: await planLevel(deps, [...dir, filename], [], source.children),
      });
      continue;
    }
    const { name, extension } = splitAllocatedFilename(filename, source.extension);
    planned.push({
      kind: "file",
      source,
      id: source.copyId ?? crypto.randomUUID(),
      name,
      extension,
      path,
      uri: deps.holderUri(path),
    });
  }
  return planned;
}

/** A rendered filename split back into the stored name and extension. */
function splitAllocatedFilename(
  filename: string,
  extension: string,
): { name: string; extension: string } {
  return extension && filename.endsWith(`.${extension}`)
    ? { name: filename.slice(0, -(extension.length + 1)), extension }
    : { name: filename, extension: "" };
}

/** Every name this parent holds for a reader: live folders and live documents. */
async function occupantClaims(
  deps: CopyTreeDeps,
  parentId: string | null,
): Promise<NamespaceNameClaim[]> {
  const [folders, documents] = await Promise.all([
    deps.store.listFolders(LIVE_TREE, parentId),
    deps.store.listDocuments(LIVE_TREE, parentId),
  ]);
  return [
    ...folders.map((folder) => ({ kind: "folder" as const, filename: folder.name })),
    ...documents.map((document) => ({
      kind: "document" as const,
      filename: renderFilename(document.name, document.extension),
    })),
  ];
}
