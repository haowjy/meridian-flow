/**
 * One ContextFS source's Copy capability: the frozen subtree read a copy starts from, and the
 * destination half (`copy-tree.ts`): the plan and the insert. `context/copy/` decides what to
 * copy and in what order; this only knows this namespace.
 */

import { compareCatalogSiblings } from "@meridian/project-tree";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { joinPath, renderFilename } from "../../context/paths.js";
import type { AdapterFault } from "../../ports/context-adapter.js";
import type {
  ContextCopyAdapter,
  CopySourceEntry,
  CopySourceFile,
  CopySourceFolder,
} from "../../ports/context-copy.js";
import type { ContextDocument, ContextFolder } from "../../ports/context-document-store.js";
import { DEFAULT_EDITABLE_FILETYPE } from "./bound-writes.js";
import { type CopyTreeDeps, insertCopiedTree, planCopyTree } from "./copy-tree.js";

export interface ContextFsCopyDeps extends CopyTreeDeps {
  /** Why this placement cannot take a copy (a draft placement), or null. */
  refuseReceive(): AdapterFault | null;
}

export function createContextFsCopyAdapter(deps: ContextFsCopyDeps): ContextCopyAdapter {
  const { store, holderUri, folderUri } = deps;

  /**
   * The source subtree of node `id`, wherever it stands now (live, or in Trash with what its
   * delete took): the folder with every descendant in its visible order, or the one file. `path`
   * only spells the root's address; the id decides which node is copied.
   */
  async function snapshotSource(source: {
    id: string;
    path: string;
  }): Promise<Result<CopySourceEntry, AdapterFault>> {
    const clean = source.path.replace(/\/+$/, "");
    if (!clean) {
      return Err({
        code: "invalid_operation",
        message: "The source root cannot be copied; copy a file or a folder in it.",
      });
    }
    const subtree = await store.readSubtree(source.id);
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
    planCopy: async (input) => {
      const refused = deps.refuseReceive();
      return refused ? Err(refused) : Ok(await planCopyTree(deps, input));
    },
    copyInto: (input) => insertCopiedTree(deps, input),
  };
}
