/**
 * One ContextFS source's Copy capability: the frozen subtree read a copy starts from, and the
 * destination half (`copy-tree.ts`): the plan and the insert. `context/copy/` decides what to
 * copy and in what order; this only knows this namespace.
 */

import { compareCatalogSiblings } from "@meridian/project-tree";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import type { DraftPeerShadowAccess } from "../../../collab/index.js";
import { joinPath, renderFilename } from "../../context/paths.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import type {
  ContextCopyAdapter,
  CopySourceEntry,
  CopySourceFile,
  CopySourceFolder,
} from "../../ports/context-copy.js";
import type {
  ContextDocument,
  ContextDocumentStore,
  ContextFolder,
  ContextSubtree,
} from "../../ports/context-document-store.js";
import type { TreeView } from "../../tree/tree-view.js";
import { DEFAULT_EDITABLE_FILETYPE } from "./bound-writes.js";
import { type CopyTreeDeps, insertPlannedTrees, planCopyTree } from "./copy-tree.js";

type ContextFsCopyDeps = CopyTreeDeps & {
  documentSync: CopyTreeDeps["documentSync"] &
    Pick<DraftPeerShadowAccess, "writeCreatedDraftContent">;
};

export function createContextFsCopyAdapter(deps: ContextFsCopyDeps): ContextCopyAdapter {
  const { store, holderUri, folderUri } = deps;

  /**
   * The source subtree of node `id`, wherever it stands now (live, or in Trash with what its
   * delete took): the folder with every descendant in its visible order, or the one file. `path`
   * only spells the root's address; the id decides which node is copied. A draft `view` reads the
   * Work's tree, where the node must be placed.
   */
  async function snapshotSource(source: {
    id: string;
    path: string;
    view: TreeView;
  }): Promise<Result<CopySourceEntry, AdapterFault>> {
    const clean = source.path.replace(/\/+$/, "");
    if (!clean) {
      return Err({
        code: "invalid_operation",
        message: "The source root cannot be copied; copy a file or a folder in it.",
      });
    }
    const subtree =
      source.view.kind === "live"
        ? await store.readSubtree(source.id)
        : await viewSubtree(store, source.view, source.id);
    if (!subtree) return Err({ code: "not_found" });
    if (subtree.root.kind === "document") return Ok(fileSnapshot(clean, subtree.root.document));
    const folders = new Map<string | null, ContextFolder[]>();
    for (const child of subtree.folders)
      folders.set(child.parentId, [...(folders.get(child.parentId) ?? []), child]);
    const documents = new Map<string | null, ContextDocument[]>();
    for (const child of subtree.documents)
      documents.set(child.folderId, [...(documents.get(child.folderId) ?? []), child]);
    const folderSnapshot = (path: string, folder: ContextFolder): CopySourceFolder => {
      const siblings = [
        ...(folders.get(folder.id) ?? []).map((child) => ({
          order: { kind: "folder" as const, name: child.name, rank: child.rank, entryId: child.id },
          folder: child,
        })),
        ...(documents.get(folder.id) ?? []).map((child) => ({
          order: {
            kind: "file" as const,
            name: renderFilename(child.name, child.extension),
            rank: child.rank,
            entryId: child.id,
          },
          document: child,
        })),
      ].sort((left, right) => compareCatalogSiblings(left.order, right.order));
      return {
        kind: "folder",
        path,
        uri: folderUri(path),
        folderId: folder.id,
        name: folder.name,
        children: siblings.map((sibling) =>
          "folder" in sibling
            ? folderSnapshot(joinPath(path, sibling.folder.name), sibling.folder)
            : fileSnapshot(
                joinPath(path, renderFilename(sibling.document.name, sibling.document.extension)),
                sibling.document,
              ),
        ),
      };
    };
    return Ok(folderSnapshot(clean, subtree.root.folder));
  }

  function fileSnapshot(path: string, document: ContextDocument): CopySourceFile {
    const binary = document.fileType !== null;
    return {
      kind: "file",
      path,
      uri: holderUri(path),
      documentId: document.id,
      name: document.name,
      extension: document.extension,
      filetype: document.filetype ?? DEFAULT_EDITABLE_FILETYPE,
      fileType: document.fileType,
      storageUrl: binary ? document.storageUrl : null,
      mimeType: binary ? document.mimeType : null,
      sizeBytes: binary ? document.sizeBytes : null,
      hasPreview: binary && document.hasPreview,
    };
  }

  return {
    sourceId: () => store.existingContextSourceId(),
    snapshotSource,
    planCopy: async (input) => Ok(await planCopyTree(deps, input)),
    copyInto: async (input) =>
      input.plan.dir.join("/") !== input.dir.join("/")
        ? Ok({ kind: "replan" })
        : insertPlannedTrees(
            deps,
            [input],
            input.position,
            input.branchId
              ? { branchId: input.branchId, documentSync: deps.documentSync }
              : undefined,
          ),
  };
}

/** The subtree of node `id` as a Work's draft tree places it, from one read of the view. */
async function viewSubtree(
  store: ContextDocumentStore,
  view: TreeView,
  id: string,
): Promise<ContextSubtree | null> {
  const tree = await store.listTree(view);
  const document = tree.documents.find((candidate) => candidate.id === id);
  if (document) return { root: { kind: "document", document }, folders: [], documents: [] };
  const root = tree.folders.find((candidate) => candidate.id === id);
  if (!root) return null;
  const inside = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const folder of tree.folders)
      if (folder.parentId && inside.has(folder.parentId) && !inside.has(folder.id)) {
        inside.add(folder.id);
        grew = true;
      }
  }
  return {
    root: { kind: "folder", folder: root },
    folders: tree.folders.filter((folder) => folder.id !== id && inside.has(folder.id)),
    documents: tree.documents.filter((doc) => doc.folderId && inside.has(doc.folderId)),
  };
}
