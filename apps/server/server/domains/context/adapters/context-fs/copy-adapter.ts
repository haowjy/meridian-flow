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
import type { ContextDocument, ContextFolder } from "../../ports/context-document-store.js";
import type { TreeView } from "../../tree/tree-view.js";
import { DEFAULT_EDITABLE_FILETYPE } from "./bound-writes.js";
import { type CopyTreeDeps, insertPlannedTrees, planCopyTree } from "./copy-tree.js";
import { AMBIGUOUS_PATH_FAULT } from "./placement.js";

type ContextFsCopyDeps = CopyTreeDeps & {
  documentSync: CopyTreeDeps["documentSync"] &
    Pick<DraftPeerShadowAccess, "writeCreatedDraftContent">;
};

export function createContextFsCopyAdapter(deps: ContextFsCopyDeps): ContextCopyAdapter {
  const { store, holderUri, folderUri } = deps;

  /** The source subtree at one path: the folder with every descendant, or one file. */
  async function snapshotSource(
    path: string,
    view: TreeView,
  ): Promise<Result<CopySourceEntry, AdapterFault>> {
    const clean = path.replace(/\/+$/, "");
    if (!clean) {
      return Err({
        code: "invalid_operation",
        message: "The source root cannot be copied; copy a file or a folder in it.",
      });
    }
    const folder = await store.resolveFolderAt(view, clean);
    if (folder.kind === "ambiguous") return Err(AMBIGUOUS_PATH_FAULT);
    if (folder.kind === "found" && folder.node) {
      return Ok(await folderSnapshot(clean, folder.node, view));
    }
    const document = await store.resolveDocumentAt(view, clean);
    if (document.kind === "ambiguous") return Err(AMBIGUOUS_PATH_FAULT);
    if (document.kind === "found") return Ok(fileSnapshot(clean, document.node));
    return Err({ code: "not_found" });
  }

  async function folderSnapshot(
    path: string,
    folder: ContextFolder,
    view: TreeView,
  ): Promise<CopySourceFolder> {
    const [folders, documents] = await Promise.all([
      store.listFolders(view, folder.id),
      store.listDocuments(view, folder.id),
    ]);
    const siblings = [
      ...folders.map((child) => ({
        order: { kind: "folder" as const, name: child.name, rank: child.rank, entryId: child.id },
        folder: child,
      })),
      ...documents.map((child) => ({
        order: {
          kind: "file" as const,
          name: renderFilename(child.name, child.extension),
          rank: child.rank,
          entryId: child.id,
        },
        document: child,
      })),
    ].sort((left, right) => compareCatalogSiblings(left.order, right.order));
    const children: CopySourceEntry[] = [];
    for (const sibling of siblings) {
      children.push(
        "folder" in sibling
          ? await folderSnapshot(joinPath(path, sibling.folder.name), sibling.folder, view)
          : fileSnapshot(
              joinPath(path, renderFilename(sibling.document.name, sibling.document.extension)),
              sibling.document,
            ),
      );
    }
    return {
      kind: "folder",
      path,
      uri: folderUri(path),
      folderId: folder.id,
      name: folder.name,
      children,
    };
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
