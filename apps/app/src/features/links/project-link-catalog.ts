/**
 * The client's `HolderCatalog`: the shared link rules (`resolveStoredLink`)
 * read the scope's local document index through it, and the account's
 * settlement memo answers `settlement()`.
 *
 * Every lookup the index cannot answer for certain is `undefined`, "not held,
 * ask the server": a `doc:` ref the complete index does not hold may name
 * another Work's Scratch or a document the reader lost, and an incomplete
 * index cannot prove what is at an address. Nothing is ever answered `null`
 * for a document, so on the client a local `gone` is only a malformed ref.
 * Folders follow the same rule: a folder the index holds answers, anything
 * else is `undefined`.
 */

import type { CatalogDocument, CatalogFolder } from "@meridian/contracts";
import { contextOwner } from "@meridian/contracts/protocol";
import type { HolderCatalog } from "@meridian/markup/links";

import { indexedDocumentAt, indexedFolderAt } from "@/core/editor/links";

import type { ProjectLinkSettlements } from "./link-settlements";
import type {
  LinkableDocument,
  LinkableDocumentIndex,
  LinkableFolder,
} from "./useLinkableDocuments";

/** The catalog, and the index row behind each document or folder it answers with. */
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
  return {
    indexed: (documentId) => byId.get(documentId),
    indexedFolder: (folderId) => foldersById.get(folderId),
    folder: (folderId) => (index.complete ? catalogFolder(foldersById.get(folderId)) : undefined),
    folderAt: (uri) =>
      index.complete ? catalogFolder(indexedFolderAt(index.folders, uri)) : undefined,
    document: (documentId) => (index.complete ? held(byId.get(documentId)) : undefined),
    settlement(aheadId) {
      const settled = settlements.get(aheadId);
      // Settled on an unknown document: never its address, so ask.
      if (settled === null) return undefined;
      // Not known settled: rule 4 shows what is at its address while the server is asked.
      return settled ?? null;
    },
    documentAt(uri) {
      if (!index.complete) return undefined;
      const document = index.documents.find((candidate) => candidate.uri === uri);
      return document ? catalogDocument(document) : null;
    },
    documentFor(uri) {
      if (!index.complete) return undefined;
      return held(indexedDocumentAt(index.documents, uri)) ?? null;
    },
    assetAddress: () => undefined,
    assetFor: () => undefined,
  };
}
