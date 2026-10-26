/**
 * Copy's destination half in one ContextFS source: naming and identity, planned without a
 * lock, and the insertion of a plan inside the caller's command transaction.
 *
 * Names are this namespace's, so allocation happens here, against live occupants, hidden
 * occupants (which are taken, never revealed) and the rest of the batch. Only the roots meet
 * occupants that already exist: a copied folder is new, so nothing live or hidden can sit
 * inside it, and the batch's own names are its whole namespace. Planning therefore reads the
 * destination parent once and holds nothing; the insert re-reads the parent under the lock
 * and, if the roots would now take other names, answers `replan` instead of inserting.
 *
 * A copied folder is inserted before its children and keeps its source's own ordering policy,
 * so inserting the children in source order reproduces the source's visible order in a manual
 * folder and leaves name order alone in a default one. Two passes, because a link may cross
 * roots: the plan mints every identity first, and the caller binds each document against the
 * whole old→new map before anything is written.
 */

import {
  allocateFilename,
  type ContextSiblingPosition,
  type Filetype,
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
import type { CopiedFrom } from "../../document-metadata.js";
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
import { LIVE_TREE } from "../../tree/tree-view.js";

export interface CopyTreeDeps {
  store: ContextDocumentStore;
  documentCreation: DocumentCreationAggregate;
  documentSync: Pick<MarkdownDocumentStore, "installSeed" | "initializeEmptyDocument">;
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
  const { plan } = input;
  if (!(await planHolds(deps, input.dir, parent.value, plan))) return Ok({ kind: "replan" });
  const minted = plan.roots;

  // The catalog reconciles the project's whole scope, so it is refreshed once, after the tree.
  const batch = deps.store.withCatalogBatch();
  try {
    const created = await insertLevel(
      { ...deps, store: batch.store },
      parent.value,
      minted,
      input.contents,
    );
    if (!created.ok) return created;
    // The roots land as one run at the position, in the order they were selected.
    let position = input.position;
    for (const root of minted) {
      if (!position) break;
      const placed = await batch.store.placeSibling({
        kind: root.kind,
        id: root.id,
        parentId: parent.value,
        position,
      });
      if (placed === "stale-anchor") return Err({ code: "stale_target" });
      position = { kind: "after", siblingId: root.id };
    }
    await batch.flush();
    return Ok({ kind: "copied", entries: created.value });
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
        id: crypto.randomUUID(),
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
      id: crypto.randomUUID(),
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

/** Every name this parent already holds: live folders, live documents, hidden occupants. */
async function occupantClaims(
  deps: CopyTreeDeps,
  parentId: string | null,
): Promise<NamespaceNameClaim[]> {
  const [folders, documents, hidden] = await Promise.all([
    deps.store.listFolders(LIVE_TREE, parentId),
    deps.store.listDocuments(LIVE_TREE, parentId),
    deps.store.listHiddenNames(parentId),
  ]);
  return [
    ...folders.map((folder) => ({ kind: "folder" as const, filename: folder.name })),
    ...documents.map((document) => ({
      kind: "document" as const,
      filename: renderFilename(document.name, document.extension),
    })),
    // A hidden occupant's rendered filename is taken. Its kind only picks the comparison:
    // a hidden folder's rendered name and a hidden document's alias both compare as names.
    ...hidden.map((filename) => ({ kind: "document" as const, filename })),
  ];
}

async function insertLevel(
  deps: CopyTreeDeps,
  parentId: string | null,
  nodes: readonly PlannedCopyNode[],
  contents: ReadonlyMap<string, CopiedContent>,
): Promise<Result<CopyCreatedEntry[], AdapterFault>> {
  const created: CopyCreatedEntry[] = [];
  for (const node of nodes) {
    if (node.kind === "folder") {
      const folderId = await deps.store.createFolderIfAbsent({
        parentId,
        name: node.name,
        id: node.id,
        orderPolicy: node.source.orderPolicy,
      });
      if (!folderId) return Err({ code: "conflict", occupantKind: "file" });
      created.push({
        kind: "folder",
        id: folderId,
        path: node.path,
        name: node.name,
        copiedFrom: node.source.folderId,
      });
      const children = await insertLevel(deps, folderId, node.children, contents);
      if (!children.ok) return children;
      created.push(...children.value);
      continue;
    }

    const rendered = renderFilename(node.name, node.extension);
    if (node.source.fileType !== null) {
      const binary = await insertCopiedBinary(deps, parentId, node);
      if (!binary.ok) return binary;
      created.push({
        kind: "file",
        id: binary.value,
        path: node.path,
        name: rendered,
        copiedFrom: node.source.documentId,
      });
      continue;
    }

    const content = contents.get(node.source.documentId);
    if (!content) throw new Error(`No content was bound for ${node.source.path}`);
    const documentId = await insertCopiedDocument(deps, parentId, node, content);
    if (!documentId.ok) return documentId;
    created.push({
      kind: "file",
      id: documentId.value,
      path: node.path,
      name: rendered,
      copiedFrom: node.source.documentId,
    });
  }
  return Ok(created);
}

/**
 * One copied tracked document: its identity, then its content or an empty authority, in the
 * creation aggregate's transaction. The claim is `none`: a hidden occupant is never revealed,
 * and if one appeared at this name the copy fails rather than adopting it.
 */
async function insertCopiedDocument(
  deps: CopyTreeDeps,
  parentId: string | null,
  node: PlannedCopyFile,
  content: CopiedContent,
): Promise<Result<string, AdapterFault>> {
  const filetype: Filetype = node.source.filetype;
  const created = await deps.documentCreation.createDocumentAtomically({
    persistIdentity: async () => {
      const claimed = await deps.store.createDocumentRecordIfAbsent(
        {
          id: node.id,
          folderId: parentId,
          name: node.name,
          extension: node.extension,
          markdown: "",
          filetype,
          metadata: { copiedFrom: content.copiedFrom },
        },
        { kind: "none" },
      );
      return claimed?.document.id ?? null;
    },
    initializeContent: async (documentId) => {
      if (content.state) await deps.documentSync.installSeed(documentId, content.state);
      else await deps.documentSync.initializeEmptyDocument(documentId);
    },
  });
  if (!created.created) return Err({ code: "conflict", occupantKind: "file" });
  return Ok(node.id);
}

/** One copied binary: the row points at the object the copy duplicated before this transaction. */
async function insertCopiedBinary(
  deps: CopyTreeDeps,
  parentId: string | null,
  node: PlannedCopyFile,
): Promise<Result<string, AdapterFault>> {
  if (!node.source.fileType || !node.source.storageUrl) {
    return Err({
      code: "io_error",
      message: `Copied binary ${node.source.path} has no stored object`,
    });
  }
  const { fileType, storageUrl, mimeType, sizeBytes } = node.source;
  try {
    const document = await deps.store.createBinaryDocument({
      id: node.id,
      folderId: parentId,
      name: node.name,
      extension: node.extension,
      fileType,
      storageUrl,
      // A binary row normally carries its type; an old row that lost it copies as opaque bytes.
      mimeType: mimeType ?? "application/octet-stream",
      sizeBytes: sizeBytes ?? 0,
      metadata: { copiedFrom: copiedFromProvenance(node) },
    });
    return Ok(document.id);
  } catch (error) {
    if (error instanceof ContextEntryConflictError) {
      return Err({ code: "conflict", occupantKind: error.occupantKind ?? "file" });
    }
    throw error;
  }
}

function copiedFromProvenance(node: PlannedCopyFile): CopiedFrom {
  // A binary has no drafts or revisions, so its copy always records the live file.
  return { uri: node.source.uri, version: "live", revision: null };
}
