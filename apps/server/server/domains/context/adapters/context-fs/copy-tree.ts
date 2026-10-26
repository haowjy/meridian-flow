/**
 * Copy's insertion half in one ContextFS source: naming, identity, content and arrival for
 * a tree another source's snapshot described, inside the caller's command transaction.
 *
 * Names are this namespace's, so allocation happens here, against live occupants, hidden
 * occupants (which are taken, never revealed) and the rest of the batch. A copied folder is
 * inserted before its children and keeps its source's own ordering policy, so inserting the
 * children in source order reproduces the source's visible order in a manual folder and
 * leaves name order alone in a default one.
 *
 * Two passes, because a link may cross roots: mint every identity first, hand back the whole
 * old→new map to `bind` for each document, then write rows and content in one order.
 */

import {
  allocateFilename,
  type ContextSiblingPosition,
  type Filetype,
  type NamespaceNameClaim,
  renderFilename,
  sameNamespaceName,
} from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import {
  type BoundWrite,
  type CopyIdentityMap,
  createCopyIdentityMap,
  type DocumentCreationAggregate,
  type MarkdownDocumentStore,
  type SyncError,
} from "../../../collab/index.js";
import type { CopiedFrom } from "../../document-metadata.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import type {
  CopiedContent,
  CopyCreatedEntry,
  CopySourceEntry,
  CopySourceFile,
  CopySourceFolder,
} from "../../ports/context-copy.js";
import {
  type ContextDocumentStore,
  ContextEntryConflictError,
} from "../../ports/context-document-store.js";
import { LIVE_TREE } from "../../tree/tree-view.js";

/** Thrown inside the aggregate when the content seed fails; mapped to an adapter fault. */
class CopiedContentFault extends Error {
  constructor(readonly fault: AdapterFault) {
    super("Copied content could not be written");
  }
}

export interface CopyTreeDeps {
  store: ContextDocumentStore;
  documentCreation: DocumentCreationAggregate;
  documentSync: Pick<MarkdownDocumentStore, "seedFromMarkdown" | "initializeEmptyDocument">;
  /** The canonical address of a scheme-relative path in this source. */
  holderUri(path: string): string;
  syncFault(error: SyncError): AdapterFault;
}

type PlannedFolder = {
  kind: "folder";
  source: CopySourceFolder;
  id: string;
  name: string;
  /** Scheme-relative path the copy lands at. */
  path: string;
  uri: string;
  children: PlannedNode[];
};

type PlannedFile = {
  kind: "file";
  source: CopySourceFile;
  id: string;
  name: string;
  extension: string;
  path: string;
  uri: string;
  content: BoundWrite | null;
  /** What the source read was; the row records it as `metadata.copiedFrom`. */
  copiedFrom: CopiedFrom | null;
};

type PlannedNode = PlannedFolder | PlannedFile;

export interface CopyTreeInput {
  /** Scheme-relative destination folder. */
  dir: readonly string[];
  roots: readonly CopySourceEntry[];
  /** An explicit sibling position for the run of roots: the first lands there, the rest follow. */
  position?: ContextSiblingPosition;
  bind(input: {
    file: CopySourceFile;
    uri: string;
    map: CopyIdentityMap;
  }): Promise<Result<CopiedContent, AdapterFault>>;
}

export async function insertCopiedTree(
  deps: CopyTreeDeps,
  input: CopyTreeInput,
): Promise<Result<CopyCreatedEntry[], AdapterFault>> {
  const parent = await ensureDestinationParent(deps, input.dir);
  if (!parent.ok) return parent;

  // Only the roots meet occupants that already exist: a copied folder is new, so nothing
  // live or hidden can sit inside it, and the batch's own names are the whole namespace there.
  const planned = await planLevel(
    deps,
    [...input.dir],
    await occupantClaims(deps, parent.value),
    input.roots,
  );
  if (!planned.ok) return planned;
  const minted = planned.value;

  const identity = createCopyIdentityMap({
    // Binaries are in the map too: an image inside the copied set must show its copy.
    documents: flatten(minted).flatMap((node) =>
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
    folders: flatten(minted).flatMap((node) =>
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

  for (const node of flatten(minted)) {
    if (node.kind === "folder" || node.source.fileType !== null) continue;
    const content = await input.bind({ file: node.source, uri: node.uri, map: identity });
    if (!content.ok) return content;
    node.content = content.value.content;
    node.copiedFrom = content.value.copiedFrom;
  }

  // The catalog reconciles the project's whole scope, so it is refreshed once, after the tree.
  const batch = deps.store.withCatalogBatch();
  try {
    const created = await insertLevel({ ...deps, store: batch.store }, parent.value, minted);
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
    return created;
  } catch (error) {
    if (error instanceof CopiedContentFault) return Err(error.fault);
    if (error instanceof ContextEntryConflictError) {
      return Err({
        code: "conflict",
        ...(error.occupantKind ? { occupantKind: error.occupantKind } : {}),
      });
    }
    throw error;
  }
}

function flatten(nodes: readonly PlannedNode[]): PlannedNode[] {
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

/** Allocate every name and mint every identity, parents before their children. */
async function planLevel(
  deps: CopyTreeDeps,
  dir: readonly string[],
  taken: NamespaceNameClaim[],
  sources: readonly CopySourceEntry[],
): Promise<Result<PlannedNode[], AdapterFault>> {
  const planned: PlannedNode[] = [];
  for (const source of sources) {
    if (source.kind === "folder") {
      const filename = await allocateFilename({ kind: "folder", name: source.name }, (candidate) =>
        taken.some((claim) => sameNamespaceName(candidate, claim)),
      );
      const path = [...dir, filename].join("/");
      taken.push({ kind: "folder", filename });
      const children = await planLevel(deps, [...dir, filename], [], source.children);
      if (!children.ok) return children;
      planned.push({
        kind: "folder",
        source,
        id: crypto.randomUUID(),
        name: filename,
        path,
        uri: deps.holderUri(path),
        children: children.value,
      });
      continue;
    }
    const filename = await allocateFilename(
      { kind: "document", name: source.name, extension: source.extension },
      (candidate) => taken.some((claim) => sameNamespaceName(candidate, claim)),
    );
    const path = [...dir, filename].join("/");
    taken.push({ kind: "document", filename });
    const { name, extension } = splitAllocatedFilename(filename, source.extension);
    planned.push({
      kind: "file",
      source,
      id: crypto.randomUUID(),
      name,
      extension,
      path,
      uri: deps.holderUri(path),
      content: null,
      copiedFrom: null,
    });
  }
  return Ok(planned);
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
  nodes: readonly PlannedNode[],
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
      const children = await insertLevel(deps, folderId, node.children);
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

    const documentId = await insertCopiedDocument(deps, parentId, node);
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
  node: PlannedFile,
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
          metadata: { copiedFrom: node.copiedFrom ?? copiedFromProvenance(node) },
        },
        { kind: "none" },
      );
      return claimed?.document.id ?? null;
    },
    initializeContent: async (documentId) => {
      if (node.content) {
        const seeded = await deps.documentSync.seedFromMarkdown(documentId, node.content, {
          type: "system",
        });
        if (!seeded.ok) throw new CopiedContentFault(deps.syncFault(seeded.error));
        return;
      }
      await deps.documentSync.initializeEmptyDocument(documentId as DocumentId);
    },
  });
  if (!created.created) return Err({ code: "conflict", occupantKind: "file" });
  return Ok(node.id);
}

/** One copied binary: the row points at the object the copy duplicated before this transaction. */
async function insertCopiedBinary(
  deps: CopyTreeDeps,
  parentId: string | null,
  node: PlannedFile,
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

function copiedFromProvenance(node: PlannedFile): CopiedFrom {
  // A binary has no drafts or revisions, so its copy always records the live file.
  return { uri: node.source.uri, version: "live", revision: null };
}
