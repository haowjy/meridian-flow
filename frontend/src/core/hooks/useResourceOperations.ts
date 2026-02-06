import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import { useTreeStore } from "@/core/stores/useTreeStore";
import { useUIStore } from "@/core/stores/useUIStore";
import { useProjectStore } from "@/core/stores/useProjectStore";
import { closeEditor } from "@/core/lib/panelHelpers";

/**
 * Check if a document is inside a folder (or its descendants).
 * Traverses UP from document's folderId through parent chain.
 */
function isDocumentInFolder(
  docId: string,
  targetFolderId: string,
  documents: { id: string; folderId: string | null }[],
  folders: { id: string; parentId: string | null }[],
): boolean {
  const doc = documents.find((d) => d.id === docId);
  if (!doc || !doc.folderId) return false;

  let currentFolderId: string | null = doc.folderId;
  while (currentFolderId) {
    if (currentFolderId === targetFolderId) return true;
    const folder = folders.find((f) => f.id === currentFolderId);
    currentFolderId = folder?.parentId ?? null;
  }
  return false;
}

/**
 * Hook providing navigation-aware resource operations.
 * Handles "navigate away before delete" pattern for all resource types.
 *
 * This hook centralizes the coordination between UI navigation and data operations,
 * ensuring we never try to view a resource that's being deleted.
 *
 * @example
 * const { deleteDocument, deleteFolder } = useResourceOperations(projectId)
 * await deleteDocument(docId)  // Auto-navigates away if needed
 */
export function useResourceOperations(projectId: string) {
  const navigate = useNavigate();
  const activeDocumentId = useUIStore((s) => s.activeDocumentId);

  // Get project slug for URL navigation
  const projectSlug = useProjectStore((s) => {
    const project =
      s.projects.find((p) => p.id === projectId) || s.currentProject();
    return project?.slug ?? projectId; // Fallback to ID for backwards compat
  });

  const { documents, folders, deleteDocument, deleteFolder } = useTreeStore(
    useShallow((s) => ({
      documents: s.documents,
      folders: s.folders,
      deleteDocument: s.deleteDocument,
      deleteFolder: s.deleteFolder,
    })),
  );

  /**
   * Delete a document, navigating away first if it's currently open.
   */
  const deleteDocumentWithNav = useCallback(
    async (documentId: string) => {
      // Navigate away FIRST if deleting the active document
      if (activeDocumentId === documentId) {
        closeEditor(projectSlug, navigate);
      }
      await deleteDocument(documentId, projectId);
    },
    [activeDocumentId, projectId, projectSlug, navigate, deleteDocument],
  );

  /**
   * Delete a folder, navigating away first if it contains the active document.
   */
  const deleteFolderWithNav = useCallback(
    async (folderId: string) => {
      // Navigate away FIRST if active document is inside the folder
      if (
        activeDocumentId &&
        isDocumentInFolder(activeDocumentId, folderId, documents, folders)
      ) {
        closeEditor(projectSlug, navigate);
      }
      await deleteFolder(folderId, projectId);
    },
    [
      activeDocumentId,
      projectId,
      projectSlug,
      navigate,
      deleteFolder,
      documents,
      folders,
    ],
  );

  return {
    deleteDocument: deleteDocumentWithNav,
    deleteFolder: deleteFolderWithNav,
  };
}
