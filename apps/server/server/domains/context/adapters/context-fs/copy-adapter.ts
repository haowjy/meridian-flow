/**
 * One ContextFS source's Copy capability: the frozen subtree read a copy starts from, and the
 * destination half (`copy-tree.ts`): the plan and the insert. `context/copy/` decides what to
 * copy and in what order; this only knows this namespace.
 */

import { compareCatalogSiblings } from "@meridian/resource-replica";
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
import { LIVE_TREE } from "../../tree/tree-view.js";
import { DEFAULT_EDITABLE_FILETYPE } from "./bound-writes.js";
import { type CopyTreeDeps, insertCopiedTree, planCopyTree } from "./copy-tree.js";
import { AMBIGUOUS_PATH_FAULT } from "./create-placement.js";

export interface ContextFsCopyDeps extends CopyTreeDeps {
  /** Why this placement cannot take a copy (a draft placement), or null. */
  refuseReceive(): AdapterFault | null;
}

export function createContextFsCopyAdapter(deps: ContextFsCopyDeps): ContextCopyAdapter {
  const { store, holderUri } = deps;

  /** The source subtree at one path: the folder with every descendant, or one file. */
  async function snapshotSource(path: string): Promise<Result<CopySourceEntry, AdapterFault>> {
    const clean = path.replace(/\/+$/, "");
    if (!clean) {
      return Err({
        code: "invalid_operation",
        message: "The source root cannot be copied; copy a file or a folder in it.",
      });
    }
    const folder = await store.resolveFolderAt(LIVE_TREE, clean);
    if (folder.kind === "ambiguous") return Err(AMBIGUOUS_PATH_FAULT);
    if (folder.kind === "found" && folder.node) {
      return Ok(await folderSnapshot(clean, folder.node));
    }
    const document = await store.resolveDocumentAt(LIVE_TREE, clean);
    if (document.kind === "ambiguous") return Err(AMBIGUOUS_PATH_FAULT);
    if (document.kind === "found") return Ok(fileSnapshot(clean, document.node));
    return Err({ code: "not_found" });
  }

  async function folderSnapshot(path: string, folder: ContextFolder): Promise<CopySourceFolder> {
    const [orderPolicy, folders, documents] = await Promise.all([
      store.parentOrderPolicy(LIVE_TREE, folder.id),
      store.listFolders(LIVE_TREE, folder.id),
      store.listDocuments(LIVE_TREE, folder.id),
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
    ].sort((left, right) =>
      compareCatalogSiblings(orderPolicy === "manual", left.order, right.order),
    );
    const children: CopySourceEntry[] = [];
    for (const sibling of siblings) {
      children.push(
        "folder" in sibling
          ? await folderSnapshot(joinPath(path, sibling.folder.name), sibling.folder)
          : fileSnapshot(
              joinPath(path, renderFilename(sibling.document.name, sibling.document.extension)),
              sibling.document,
            ),
      );
    }
    return {
      kind: "folder",
      path,
      uri: holderUri(path),
      folderId: folder.id,
      name: folder.name,
      orderPolicy,
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
    planCopy: async (input) => {
      const refused = deps.refuseReceive();
      return refused ? Err(refused) : Ok(await planCopyTree(deps, input));
    },
    copyInto: (input) => insertCopiedTree(deps, input),
  };
}
