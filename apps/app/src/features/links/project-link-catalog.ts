import type { CatalogDocument, CatalogFolder } from "@meridian/contracts";
import { contextOwner } from "@meridian/contracts/protocol";
import type { HolderCatalog } from "@meridian/markup/links";
import type { ProjectLinkSettlements } from "@/client/link-settlements";
import { indexedDocumentAt, indexedFolderAt } from "@/core/editor/links";
import type {
  LinkableDocument,
  LinkableDocumentIndex,
  LinkableFolder,
} from "./useLinkableDocuments";

export type ProjectLinkCatalog = HolderCatalog & {
  indexed(documentId: string): LinkableDocument | undefined;
  indexedFolder(folderId: string): LinkableFolder | undefined;
};

export function createProjectLinkCatalog(
  projectId: string,
  index: LinkableDocumentIndex,
  settlements: ProjectLinkSettlements,
): ProjectLinkCatalog {
  const byId = new Map(index.documents.map((document) => [document.documentId, document]));
  const foldersById = new Map(index.folders.map((folder) => [folder.folderId, folder]));
  const catalogFolder = (folder: LinkableFolder | null | undefined): CatalogFolder | undefined =>
    folder
      ? { folderId: folder.folderId, uri: folder.uri, readable: true, nameable: true }
      : undefined;
  const catalogDocument = (document: LinkableDocument): CatalogDocument => ({
    documentId: document.documentId,
    owner: contextOwner(document.workId, document.rootThreadId),
    projectId,
    uri: document.uri,
    presence: "live",
    readable: true,
    nameable: true,
  });
  const held = (document: LinkableDocument | null | undefined) =>
    document ? catalogDocument(document) : undefined;
  const documentFor = (uri: string) =>
    index.complete ? (held(indexedDocumentAt(index, uri)) ?? null) : undefined;
  return {
    indexed: (documentId) => byId.get(documentId),
    indexedFolder: (folderId) => foldersById.get(folderId),
    folder: (folderId) => (index.complete ? catalogFolder(foldersById.get(folderId)) : undefined),
    folderAt: (uri) => (index.complete ? catalogFolder(indexedFolderAt(index, uri)) : undefined),
    document: (documentId) => (index.complete ? held(byId.get(documentId)) : undefined),
    settlement(aheadId) {
      const settled = settlements.get(aheadId);
      if (settled === null) return undefined;
      return settled ?? null;
    },
    documentAt: documentFor,
    documentFor,
    assetAddress: () => undefined,
    assetFor: () => undefined,
  };
}
