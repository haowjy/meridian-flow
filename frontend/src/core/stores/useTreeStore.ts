import { create } from "zustand";
import { Document } from "@/features/documents/types/document";
import { Folder } from "@/features/folders/types/folder";
import { buildTree, TreeNode } from "@/core/lib/treeBuilder";
import { api } from "@/core/lib/api";
import { getErrorMessageWithFallback, isAbortError } from "@/core/lib/errors";
import { db } from "@/core/lib/db";
import { cancelRetry } from "@/core/lib/sync";
import { getDescendantDocumentIds } from "@/core/lib/treeUtils";

type LoadStatus = "idle" | "loading" | "success" | "error";

interface TreeStore {
  documents: Document[];
  folders: Folder[];
  tree: TreeNode[];
  expandedFolders: Set<string>;
  status: LoadStatus;
  isFetching: boolean;
  error: string | null;
  /** Project ID for the currently cached tree (enables freshness check) */
  treeProjectId: string | null;
  /** Timestamp of last successful tree fetch (prevents redundant fetches on tab switch) */
  treeLoadedAt: number | null;

  // Multi-select state
  selectedIds: Set<string>;

  // Computed getter for backwards compatibility
  isLoading: boolean;

  loadTree: (projectId: string, signal?: AbortSignal) => Promise<void>;
  toggleFolder: (folderId: string) => void;
  expandFolder: (folderId: string) => void;
  createDocument: (
    projectId: string,
    folderId: string | null,
    name: string,
  ) => Promise<void>;
  createFolder: (
    projectId: string,
    parentId: string | null,
    name: string,
  ) => Promise<void>;
  deleteDocument: (id: string, projectId: string) => Promise<void>;
  deleteFolder: (id: string, projectId: string) => Promise<void>;
  renameDocument: (
    id: string,
    name: string,
    projectId: string,
  ) => Promise<void>;
  renameFolder: (id: string, name: string, projectId: string) => Promise<void>;
  clearError: () => void;

  // Multi-select actions
  toggleSelection: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  /**
   * Hydrate tree store from str_replace_based_edit_tool view folder result.
   * Handles flat folder listing (immediate children only).
   */
  hydrateFromFolderView: (
    parentFolderId: string | null,
    folders: Array<{ id: string; name: string }>,
    documents: Array<{
      id: string;
      name: string;
      word_count: number;
      updated_at?: string;
    }>,
  ) => void;
}

export const useTreeStore = create<TreeStore>()((set, get) => ({
  documents: [],
  folders: [],
  tree: [],
  expandedFolders: new Set(),
  status: "idle" as LoadStatus,
  isFetching: false,
  error: null,
  treeProjectId: null,
  treeLoadedAt: null,

  // Multi-select state
  selectedIds: new Set(),

  // Computed getter for backwards compatibility
  get isLoading() {
    return get().status === "loading";
  },

  loadTree: async (projectId: string, signal?: AbortSignal) => {
    const currentState = get();
    const hasCachedData =
      currentState.tree.length > 0 && currentState.treeProjectId === projectId;

    // Skip if data is fresh (< 30s old) for the same project.
    // Prevents redundant fetches when Activity re-fires effects on tab switch.
    const isFresh =
      hasCachedData &&
      currentState.treeLoadedAt !== null &&
      Date.now() - currentState.treeLoadedAt < 30_000;
    if (isFresh) return;

    // Set loading state based on whether we have cached tree data
    const status = currentState.tree.length === 0 ? "loading" : "success";
    set({ status, isFetching: true, error: null });

    try {
      // Fetch tree from backend (already flattened by fromDocumentTreeDto mapper)
      const response = await api.documents.getTree(projectId, { signal });

      // Build hierarchical tree structure from flat arrays
      const tree = buildTree(response.folders, response.documents);

      // Cache full documents in IndexedDB (only those with content)
      const fullDocuments = response.documents.filter(
        (doc): doc is Document & { content: string } =>
          doc.content !== undefined,
      );
      if (fullDocuments.length > 0) {
        await Promise.all(fullDocuments.map((doc) => db.documents.put(doc)));
      }

      // Update store
      set({
        folders: response.folders,
        documents: response.documents,
        tree,
        status: "success",
        isFetching: false,
        treeProjectId: projectId,
        treeLoadedAt: Date.now(),
      });
    } catch (error) {
      // Handle AbortError silently (expected when loading new project)
      if (isAbortError(error)) {
        set({ isFetching: false });
        return;
      }

      const message = getErrorMessageWithFallback(
        error,
        "Failed to load documents",
      );
      // If we have cached tree data, keep status as 'success', otherwise set to 'error'
      const currentTree = get().tree;
      const errorStatus = currentTree.length > 0 ? "success" : "error";
      set({ error: message, status: errorStatus, isFetching: false });
    }
  },

  toggleFolder: (folderId) => {
    set((state) => {
      const expanded = new Set(state.expandedFolders);
      if (expanded.has(folderId)) {
        expanded.delete(folderId);
      } else {
        expanded.add(folderId);
      }
      return { expandedFolders: expanded };
    });
  },

  expandFolder: (folderId) => {
    set((state) => {
      if (state.expandedFolders.has(folderId)) return state;
      const expanded = new Set(state.expandedFolders);
      expanded.add(folderId);
      return { expandedFolders: expanded };
    });
  },

  createDocument: async (projectId, folderId, name) => {
    set({ error: null });
    try {
      await api.documents.create(projectId, folderId, name);
      // Reload tree to reflect new document
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      const message = getErrorMessageWithFallback(
        error,
        "Failed to create document",
      );
      set({ error: message });
      throw error;
    }
  },

  createFolder: async (projectId, parentId, name) => {
    set({ error: null });
    try {
      await api.folders.create(projectId, parentId, name);
      // Reload tree to reflect new folder
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      const message = getErrorMessageWithFallback(
        error,
        "Failed to create folder",
      );
      set({ error: message });
      throw error;
    }
  },

  deleteDocument: async (id, projectId) => {
    set({ error: null });
    try {
      // Cancel any pending retries FIRST to prevent stale content from being re-synced
      // after we delete the document from cache and server
      cancelRetry(id);

      // Clear from IndexedDB cache to prevent race conditions
      // where URL sync might try to load a deleted document
      await db.documents.delete(id);
      await api.documents.delete(id);
      // Reload tree to reflect deletion
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      const message = getErrorMessageWithFallback(
        error,
        "Failed to delete document",
      );
      set({ error: message });
      throw error;
    }
  },

  deleteFolder: async (id, projectId) => {
    set({ error: null });
    try {
      // Cleanup before delete: cancel retries and clear IndexedDB cache for all
      // descendant documents. The backend will cascade-delete them, but we need
      // to prevent stale retry attempts and clear local cache to avoid 404s.
      const descendantDocIds = getDescendantDocumentIds(get().tree, id);
      for (const docId of descendantDocIds) {
        cancelRetry(docId);
        await db.documents.delete(docId);
      }

      await api.folders.delete(id);
      // Reload tree to reflect deletion
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      const message = getErrorMessageWithFallback(
        error,
        "Failed to delete folder",
      );
      set({ error: message });
      throw error;
    }
  },

  renameDocument: async (id, name, projectId) => {
    set({ error: null });
    try {
      await api.documents.rename(id, projectId, name);
      // Reload tree to reflect rename
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      const message = getErrorMessageWithFallback(
        error,
        "Failed to rename document",
      );
      set({ error: message });
      throw error;
    }
  },

  renameFolder: async (id, name, projectId) => {
    set({ error: null });
    try {
      await api.folders.rename(id, projectId, name);
      // Reload tree to reflect rename
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      const message = getErrorMessageWithFallback(
        error,
        "Failed to rename folder",
      );
      set({ error: message });
      throw error;
    }
  },

  clearError: () => set({ error: null }),

  hydrateFromFolderView: (parentFolderId, viewFolders, viewDocuments) => {
    set((state) => {
      // Merge folders: add new, update existing (by id)
      const folderMap = new Map(state.folders.map((f) => [f.id, f]));
      for (const folder of viewFolders) {
        const existing = folderMap.get(folder.id);
        if (existing) {
          // Update name if changed
          folderMap.set(folder.id, {
            ...existing,
            name: folder.name,
            parentId: parentFolderId,
          });
        } else {
          // Add new folder (partial data)
          folderMap.set(folder.id, {
            id: folder.id,
            name: folder.name,
            parentId: parentFolderId,
          } as Folder);
        }
      }

      // Merge documents: add new, update existing (by id)
      const docMap = new Map(state.documents.map((d) => [d.id, d]));
      for (const doc of viewDocuments) {
        // Derive extension and name from full filename
        const lastDot = doc.name.lastIndexOf(".");
        const extension = lastDot > 0 ? doc.name.slice(lastDot) : ".md";
        const name = lastDot > 0 ? doc.name.slice(0, lastDot) : doc.name;
        const filename = doc.name;

        const existing = docMap.get(doc.id);
        if (existing) {
          // Update existing document
          docMap.set(doc.id, {
            ...existing,
            name,
            filename,
            extension,
            folderId: parentFolderId,
            wordCount: doc.word_count,
            updatedAt: doc.updated_at
              ? new Date(doc.updated_at)
              : existing.updatedAt,
          });
        } else {
          // Add new document (partial data)
          docMap.set(doc.id, {
            id: doc.id,
            name,
            filename,
            extension,
            folderId: parentFolderId,
            wordCount: doc.word_count,
            updatedAt: doc.updated_at ? new Date(doc.updated_at) : new Date(),
          } as Document);
        }
      }

      const mergedFolders = Array.from(folderMap.values());
      const mergedDocuments = Array.from(docMap.values());

      // Rebuild tree from merged data
      const tree = buildTree(mergedFolders, mergedDocuments);

      return {
        folders: mergedFolders,
        documents: mergedDocuments,
        tree,
        status: tree.length > 0 ? "success" : state.status,
      };
    });
  },

  // Multi-select actions
  toggleSelection: (id) => {
    set((state) => {
      const selected = new Set(state.selectedIds);
      if (selected.has(id)) {
        selected.delete(id);
      } else {
        selected.add(id);
      }
      return { selectedIds: selected };
    });
  },

  selectAll: () => {
    set((state) => {
      // Helper to recursively collect all node IDs from tree
      const collectIds = (nodes: TreeNode[]): string[] => {
        const ids: string[] = [];
        for (const node of nodes) {
          ids.push(node.id);
          if (node.type === "folder" && node.children) {
            ids.push(...collectIds(node.children));
          }
        }
        return ids;
      };

      const allIds = collectIds(state.tree);
      return { selectedIds: new Set(allIds) };
    });
  },

  clearSelection: () => {
    set({ selectedIds: new Set() });
  },
}));
