import { db } from "@/core/lib/db";
import { buildTree } from "@/core/lib/treeBuilder";
import { cancelRetry } from "@/core/lib/sync";
import { makeLogger } from "@/core/lib/logger";
import type { CachedDocumentMeta } from "@/core/lib/offlineTypes";
import { sanitizeTreeSnapshot } from "@/core/retrieval";
import { useRecentDocumentsStore } from "@/core/stores/useRecentDocumentsStore";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { useUIStore } from "@/core/stores/useUIStore";
import type { Document } from "@/features/documents/types/document";

const logger = makeLogger("document-cleanup-service");

function toCachedDocumentMeta(document: Document): CachedDocumentMeta {
  const { content, ...metadataOnly } = document;
  void content;
  return metadataOnly;
}

/**
 * Remove all local traces of a document after the server confirms it no longer exists.
 * This prevents stale IndexedDB/doc-tree data from making deleted docs appear "resurrected".
 */
export async function purgeDeletedDocumentLocalState(
  documentId: string,
): Promise<void> {
  const impactedProjectIds = new Set<string>();
  const cachedDoc = await db.documents.get(documentId);
  if (cachedDoc) {
    impactedProjectIds.add(cachedDoc.projectId);
  }

  cancelRetry(documentId);
  await db.pendingDocumentSaves.delete(documentId);
  await db.documents.delete(documentId);

  const treeState = useTreeStore.getState();
  const staleDoc = treeState.documents.find((doc) => doc.id === documentId);
  if (staleDoc) {
    impactedProjectIds.add(staleDoc.projectId);
    const nextDocuments = treeState.documents.filter(
      (doc) => doc.id !== documentId,
    );
    const normalizedTree = sanitizeTreeSnapshot({
      folders: treeState.folders,
      documents: nextDocuments,
      fallbackProjectId: staleDoc.projectId ?? treeState.treeProjectId,
      selectedIds: treeState.selectedIds,
    });
    useTreeStore.setState({
      folders: normalizedTree.folders,
      documents: normalizedTree.documents,
      selectedIds: normalizedTree.selectedIds ?? treeState.selectedIds,
      tree: buildTree(normalizedTree.folders, normalizedTree.documents),
    });
  }

  try {
    const treeCaches = await db.projectTrees.toArray();
    const dirtyCaches = treeCaches.filter((cache) =>
      cache.documents.some((doc) => doc.id === documentId),
    );
    const now = new Date().toISOString();
    for (const cache of dirtyCaches) {
      impactedProjectIds.add(cache.projectId);
      const normalizedCache = sanitizeTreeSnapshot({
        folders: cache.folders,
        documents: cache.documents.filter((doc) => doc.id !== documentId),
        fallbackProjectId: cache.projectId,
      });
      await db.projectTrees.put({
        ...cache,
        folders: normalizedCache.folders,
        documents: normalizedCache.documents.map(toCachedDocumentMeta),
        updatedAt: now,
      });
    }
  } catch (error) {
    logger.warn(
      "Failed to update project tree cache after document 404 cleanup",
      {
        documentId,
        error,
      },
    );
  }

  for (const projectId of impactedProjectIds) {
    useRecentDocumentsStore.getState().removeRecent(projectId, documentId);
  }

  const uiStore = useUIStore.getState();
  if (uiStore.activeDocumentId === documentId) {
    uiStore.setActiveDocument(null);
  }
}
