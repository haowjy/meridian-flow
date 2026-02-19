import { create } from "zustand";
import { Document } from "@/features/documents/types/document";
import { Folder } from "@/features/folders/types/folder";
import { buildTree, TreeNode } from "@/core/lib/treeBuilder";
import { api } from "@/core/lib/api";
import {
  getErrorMessageWithFallback,
  isAbortError,
  isNetworkError,
} from "@/core/lib/errors";
import { db } from "@/core/lib/db";
import type { CachedDocumentMeta, ProjectTreeCache } from "@/core/lib/offlineTypes";
import { cancelRetry } from "@/core/lib/sync";
import { getDescendantDocumentIds } from "@/core/lib/treeUtils";
import { makeLogger } from "@/core/lib/logger";
import { useErrorStore } from "@/core/stores/useErrorStore";
import {
  queueTreeOp,
  removeOpsForEntity,
} from "@/core/services/treeSyncService";

const log = makeLogger("tree-store");

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
  /**
   * Create a folder at a slash-separated path, creating any missing intermediate
   * folders along the way. Used by broken wiki-link creation (e.g. `[[a/b/c/]]`).
   */
  createFolderByPath: (projectId: string, path: string) => Promise<void>;
  deleteDocument: (id: string, projectId: string) => Promise<void>;
  deleteFolder: (id: string, projectId: string) => Promise<void>;
  renameDocument: (
    id: string,
    name: string,
    projectId: string,
  ) => Promise<void>;
  renameFolder: (id: string, name: string, projectId: string) => Promise<void>;
  moveDocument: (
    id: string,
    folderId: string | null,
    projectId: string,
  ) => Promise<void>;
  moveFolder: (
    id: string,
    parentId: string | null,
    projectId: string,
  ) => Promise<void>;
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

function toCachedDocumentMeta(document: Document): CachedDocumentMeta {
  const { content, ...metadataOnly } = document;
  void content;
  return metadataOnly;
}

// ---------------------------------------------------------------------------
// Optimistic update helpers — mutate in-memory arrays and rebuild tree
// ---------------------------------------------------------------------------

/** Rename a document in-memory: update name/filename/path, rebuild tree. */
function optimisticRenameDocument(
  documents: Document[],
  folders: Folder[],
  docId: string,
  newName: string,
): { documents: Document[]; folders: Folder[]; tree: TreeNode[] } {
  const updatedDocs = documents.map((doc) => {
    if (doc.id !== docId) return doc;
    const filename = newName + doc.extension;
    // Rebuild path: find parent folder path prefix
    const pathPrefix = buildPathPrefix(folders, doc.folderId);
    return { ...doc, name: newName, filename, path: pathPrefix + filename };
  });
  return { documents: updatedDocs, folders, tree: buildTree(folders, updatedDocs) };
}

/** Rename a folder in-memory: update name, rebuild tree. */
function optimisticRenameFolder(
  documents: Document[],
  folders: Folder[],
  folderId: string,
  newName: string,
): { documents: Document[]; folders: Folder[]; tree: TreeNode[] } {
  const updatedFolders = folders.map((f) =>
    f.id === folderId ? { ...f, name: newName } : f,
  );
  // Paths of documents inside this folder may change — rebuild paths
  const updatedDocs = rebuildDocumentPaths(documents, updatedFolders);
  return { documents: updatedDocs, folders: updatedFolders, tree: buildTree(updatedFolders, updatedDocs) };
}

/** Move a document in-memory: update folderId, rebuild path, rebuild tree. */
function optimisticMoveDocument(
  documents: Document[],
  folders: Folder[],
  docId: string,
  newFolderId: string | null,
): { documents: Document[]; folders: Folder[]; tree: TreeNode[] } {
  const updatedDocs = documents.map((doc) => {
    if (doc.id !== docId) return doc;
    const pathPrefix = buildPathPrefix(folders, newFolderId);
    return { ...doc, folderId: newFolderId, path: pathPrefix + doc.filename };
  });
  return { documents: updatedDocs, folders, tree: buildTree(folders, updatedDocs) };
}

/** Move a folder in-memory: update parentId, rebuild tree. */
function optimisticMoveFolder(
  documents: Document[],
  folders: Folder[],
  folderId: string,
  newParentId: string | null,
): { documents: Document[]; folders: Folder[]; tree: TreeNode[] } {
  const updatedFolders = folders.map((f) =>
    f.id === folderId ? { ...f, parentId: newParentId } : f,
  );
  const updatedDocs = rebuildDocumentPaths(documents, updatedFolders);
  return { documents: updatedDocs, folders: updatedFolders, tree: buildTree(updatedFolders, updatedDocs) };
}

/** Delete a document in-memory: remove from array, rebuild tree. */
function optimisticDeleteDocument(
  documents: Document[],
  folders: Folder[],
  docId: string,
): { documents: Document[]; folders: Folder[]; tree: TreeNode[] } {
  const updatedDocs = documents.filter((d) => d.id !== docId);
  return { documents: updatedDocs, folders, tree: buildTree(folders, updatedDocs) };
}

/** Delete a folder and all descendants in-memory, rebuild tree. */
function optimisticDeleteFolder(
  documents: Document[],
  folders: Folder[],
  folderId: string,
): { documents: Document[]; folders: Folder[]; tree: TreeNode[] } {
  // Collect all descendant folder IDs (recursive)
  const folderIdsToRemove = new Set<string>();
  folderIdsToRemove.add(folderId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of folders) {
      if (f.parentId !== null && folderIdsToRemove.has(f.parentId) && !folderIdsToRemove.has(f.id)) {
        folderIdsToRemove.add(f.id);
        changed = true;
      }
    }
  }

  const updatedFolders = folders.filter((f) => !folderIdsToRemove.has(f.id));
  const updatedDocs = documents.filter(
    (d) => d.folderId === null || !folderIdsToRemove.has(d.folderId),
  );
  return { documents: updatedDocs, folders: updatedFolders, tree: buildTree(updatedFolders, updatedDocs) };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Build the path prefix for a document given its folderId. */
function buildPathPrefix(folders: Folder[], folderId: string | null): string {
  if (folderId === null) return "";
  const segments: string[] = [];
  let current: string | null = folderId;
  // Walk up the folder tree to build path segments
  while (current) {
    const folder = folders.find((f) => f.id === current);
    if (!folder) break;
    segments.unshift(folder.name);
    current = folder.parentId;
  }
  return segments.length > 0 ? segments.join("/") + "/" : "";
}

/** Rebuild all document paths after folder changes (rename/move). */
function rebuildDocumentPaths(
  documents: Document[],
  folders: Folder[],
): Document[] {
  return documents.map((doc) => {
    const pathPrefix = buildPathPrefix(folders, doc.folderId);
    const newPath = pathPrefix + doc.filename;
    if (newPath === doc.path) return doc;
    return { ...doc, path: newPath };
  });
}

// ---------------------------------------------------------------------------
// Dexie cache helper — persist optimistic tree snapshot
// ---------------------------------------------------------------------------

/** Write the current in-memory tree state to the Dexie projectTrees cache. */
async function persistTreeCache(
  projectId: string,
  folders: Folder[],
  documents: Document[],
): Promise<void> {
  try {
    const treeCache: ProjectTreeCache = {
      projectId,
      folders,
      documents: documents.map(toCachedDocumentMeta),
      updatedAt: new Date().toISOString(),
    };
    await db.projectTrees.put(treeCache);
  } catch (err) {
    // Best-effort — don't block UI on cache write failure
    log.warn("Failed to persist optimistic tree cache", err);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

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
    const hasInMemoryData =
      currentState.tree.length > 0 && currentState.treeProjectId === projectId;

    // Skip if data is fresh (< 30s old) for the same project.
    // Prevents redundant fetches when Activity re-fires effects on tab switch.
    const isFresh =
      hasInMemoryData &&
      currentState.treeLoadedAt !== null &&
      Date.now() - currentState.treeLoadedAt < 30_000;
    if (isFresh) return;

    // Set loading state based on whether we already have this project's tree in memory.
    const status = hasInMemoryData ? "success" : "loading";
    set({ status, isFetching: true, error: null });

    try {
      const cachedTree = await db.projectTrees.get(projectId);
      if (cachedTree) {
        const cachedTreeData = buildTree(cachedTree.folders, cachedTree.documents);
        set({
          folders: cachedTree.folders,
          documents: cachedTree.documents,
          tree: cachedTreeData,
          status: "success",
          isFetching: true,
          error: null,
          treeProjectId: projectId,
        });
      }
    } catch (err) {
      // Cache read is best-effort. If IndexedDB read fails, continue with network fetch.
      log.warn("Cache read failed, falling back to network", err);
    }

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

      const treeCache: ProjectTreeCache = {
        projectId,
        folders: response.folders,
        documents: response.documents.map(toCachedDocumentMeta),
        updatedAt: new Date().toISOString(),
      };
      try {
        await db.projectTrees.put(treeCache);
      } catch (err) {
        // Tree cache write failure should not block rendering server data.
        log.warn("Tree cache write failed", err);
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
      // Keep cached/in-memory tree visible on network failures.
      const stateAfterFailure = get();
      const hasProjectData =
        stateAfterFailure.treeProjectId === projectId &&
        stateAfterFailure.tree.length > 0;

      if (hasProjectData) {
        set({ error: null, status: "success", isFetching: false });
        return;
      }

      set({ error: message, status: "error", isFetching: false });
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

  // -----------------------------------------------------------------------
  // Create operations — online-only (no offline support, no optimistic update)
  // -----------------------------------------------------------------------

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

  createFolderByPath: async (projectId, path) => {
    set({ error: null });
    try {
      const segments = path.split("/").filter(Boolean);
      if (segments.length === 0) return;

      let parentId: string | null = null;
      const { folders } = get();

      // Walk existing tree to find the deepest existing parent folder
      let i = 0;
      for (; i < segments.length; i++) {
        const existing = folders.find(
          (f) => f.name === segments[i] && f.parentId === parentId,
        );
        if (!existing) break;
        parentId = existing.id;
      }

      // Create missing segments from index i onward
      for (; i < segments.length; i++) {
        const folder = await api.folders.create(projectId, parentId, segments[i]!);
        parentId = folder.id;
      }

      // Reload tree to reflect new folder(s)
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      const message = getErrorMessageWithFallback(
        error,
        "Failed to create folder path",
      );
      set({ error: message });
      throw error;
    }
  },

  // -----------------------------------------------------------------------
  // Rename operations — optimistic update + offline queue
  // -----------------------------------------------------------------------

  renameDocument: async (id, name, projectId) => {
    set({ error: null });

    // 1. Optimistic in-memory update
    const { documents, folders } = get();
    const optimistic = optimisticRenameDocument(documents, folders, id, name);
    set({ documents: optimistic.documents, tree: optimistic.tree });

    // 2. Persist optimistic tree snapshot to Dexie cache
    await persistTreeCache(projectId, optimistic.folders, optimistic.documents);

    const isOffline = useErrorStore.getState().isOffline;

    if (isOffline) {
      // 3a. Offline: queue op, no API call
      await queueTreeOp(projectId, "rename", "document", id, { name });
      return;
    }

    // 3b. Online: discard stale queued ops for this entity, then call API
    try {
      await removeOpsForEntity(id);
      await api.documents.rename(id, projectId, name);
      // Reconcile with server to get authoritative state
      // Reset treeLoadedAt so loadTree doesn't skip (freshness bypass)
      set({ treeLoadedAt: null });
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      if (isNetworkError(error)) {
        // Network failure while online: queue for later retry
        log.info("Rename document failed (network), queueing", id);
        await queueTreeOp(projectId, "rename", "document", id, { name });
        return;
      }
      const message = getErrorMessageWithFallback(
        error,
        "Failed to rename document",
      );
      // Server rejected the mutation (4xx/etc). Reload now to roll back optimistic state.
      set({ treeLoadedAt: null });
      try {
        await useTreeStore.getState().loadTree(projectId);
      } catch (reloadError) {
        log.warn("Failed to reload tree after rename document rejection", reloadError);
      }
      set({ error: message });
      throw error;
    }
  },

  renameFolder: async (id, name, projectId) => {
    set({ error: null });

    // 1. Optimistic in-memory update
    const { documents, folders } = get();
    const optimistic = optimisticRenameFolder(documents, folders, id, name);
    set({ documents: optimistic.documents, folders: optimistic.folders, tree: optimistic.tree });

    // 2. Persist optimistic tree snapshot to Dexie cache
    await persistTreeCache(projectId, optimistic.folders, optimistic.documents);

    const isOffline = useErrorStore.getState().isOffline;

    if (isOffline) {
      await queueTreeOp(projectId, "rename", "folder", id, { name });
      return;
    }

    try {
      await removeOpsForEntity(id);
      await api.folders.rename(id, projectId, name);
      set({ treeLoadedAt: null });
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      if (isNetworkError(error)) {
        log.info("Rename folder failed (network), queueing", id);
        await queueTreeOp(projectId, "rename", "folder", id, { name });
        return;
      }
      const message = getErrorMessageWithFallback(
        error,
        "Failed to rename folder",
      );
      // Server rejected the mutation (4xx/etc). Reload now to roll back optimistic state.
      set({ treeLoadedAt: null });
      try {
        await useTreeStore.getState().loadTree(projectId);
      } catch (reloadError) {
        log.warn("Failed to reload tree after rename folder rejection", reloadError);
      }
      set({ error: message });
      throw error;
    }
  },

  // -----------------------------------------------------------------------
  // Move operations — optimistic update + offline queue
  // -----------------------------------------------------------------------

  moveDocument: async (id, folderId, projectId) => {
    set({ error: null });

    // 1. Optimistic in-memory update
    const { documents, folders } = get();
    const optimistic = optimisticMoveDocument(documents, folders, id, folderId);
    set({ documents: optimistic.documents, tree: optimistic.tree });

    // 2. Persist optimistic tree snapshot to Dexie cache
    await persistTreeCache(projectId, optimistic.folders, optimistic.documents);

    const isOffline = useErrorStore.getState().isOffline;

    if (isOffline) {
      await queueTreeOp(projectId, "move", "document", id, {
        folderId: folderId ?? "",
      });
      return;
    }

    try {
      await removeOpsForEntity(id);
      await api.documents.move(id, projectId, folderId);
      set({ treeLoadedAt: null });
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      if (isNetworkError(error)) {
        log.info("Move document failed (network), queueing", id);
        await queueTreeOp(projectId, "move", "document", id, {
          folderId: folderId ?? "",
        });
        return;
      }
      const message = getErrorMessageWithFallback(
        error,
        "Failed to move document",
      );
      // Server rejected the mutation (4xx/etc). Reload now to roll back optimistic state.
      set({ treeLoadedAt: null });
      try {
        await useTreeStore.getState().loadTree(projectId);
      } catch (reloadError) {
        log.warn("Failed to reload tree after move document rejection", reloadError);
      }
      set({ error: message });
      throw error;
    }
  },

  moveFolder: async (id, parentId, projectId) => {
    set({ error: null });

    // 1. Optimistic in-memory update
    const { documents, folders } = get();
    const optimistic = optimisticMoveFolder(documents, folders, id, parentId);
    set({
      documents: optimistic.documents,
      folders: optimistic.folders,
      tree: optimistic.tree,
    });

    // 2. Persist optimistic tree snapshot to Dexie cache
    await persistTreeCache(projectId, optimistic.folders, optimistic.documents);

    const isOffline = useErrorStore.getState().isOffline;

    if (isOffline) {
      await queueTreeOp(projectId, "move", "folder", id, {
        folderId: parentId ?? "",
      });
      return;
    }

    try {
      await removeOpsForEntity(id);
      await api.folders.move(id, projectId, parentId);
      set({ treeLoadedAt: null });
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      if (isNetworkError(error)) {
        log.info("Move folder failed (network), queueing", id);
        await queueTreeOp(projectId, "move", "folder", id, {
          folderId: parentId ?? "",
        });
        return;
      }
      const message = getErrorMessageWithFallback(
        error,
        "Failed to move folder",
      );
      // Server rejected the mutation (4xx/etc). Reload now to roll back optimistic state.
      set({ treeLoadedAt: null });
      try {
        await useTreeStore.getState().loadTree(projectId);
      } catch (reloadError) {
        log.warn("Failed to reload tree after move folder rejection", reloadError);
      }
      set({ error: message });
      throw error;
    }
  },

  // -----------------------------------------------------------------------
  // Delete operations — optimistic update + offline queue
  // -----------------------------------------------------------------------

  deleteDocument: async (id, projectId) => {
    set({ error: null });

    // Cancel any pending retries FIRST to prevent stale content from being re-synced
    cancelRetry(id);
    await db.pendingDocumentSaves.delete(id);
    // Clear from IndexedDB cache to prevent loading a deleted document
    await db.documents.delete(id);

    // 1. Optimistic in-memory update
    const { documents, folders } = get();
    const optimistic = optimisticDeleteDocument(documents, folders, id);
    set({ documents: optimistic.documents, tree: optimistic.tree });

    // 2. Persist optimistic tree snapshot to Dexie cache
    await persistTreeCache(projectId, optimistic.folders, optimistic.documents);

    const isOffline = useErrorStore.getState().isOffline;

    if (isOffline) {
      await queueTreeOp(projectId, "delete", "document", id, {});
      return;
    }

    try {
      await removeOpsForEntity(id);
      await api.documents.delete(id);
      set({ treeLoadedAt: null });
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      if (isNetworkError(error)) {
        log.info("Delete document failed (network), queueing", id);
        await queueTreeOp(projectId, "delete", "document", id, {});
        return;
      }
      const message = getErrorMessageWithFallback(
        error,
        "Failed to delete document",
      );
      // Server rejected the mutation (4xx/etc). Reload now to roll back optimistic state.
      set({ treeLoadedAt: null });
      try {
        await useTreeStore.getState().loadTree(projectId);
      } catch (reloadError) {
        log.warn("Failed to reload tree after delete document rejection", reloadError);
      }
      set({ error: message });
      throw error;
    }
  },

  deleteFolder: async (id, projectId) => {
    set({ error: null });

    // Cleanup before delete: cancel retries and clear IndexedDB cache for all
    // descendant documents. The backend will cascade-delete them, but we need
    // to prevent stale retry attempts and clear local cache to avoid 404s.
    const descendantDocIds = getDescendantDocumentIds(get().tree, id);
    for (const docId of descendantDocIds) {
      cancelRetry(docId);
      await db.pendingDocumentSaves.delete(docId);
      await db.documents.delete(docId);
    }

    // 1. Optimistic in-memory update
    const { documents, folders } = get();
    const optimistic = optimisticDeleteFolder(documents, folders, id);
    set({
      documents: optimistic.documents,
      folders: optimistic.folders,
      tree: optimistic.tree,
    });

    // 2. Persist optimistic tree snapshot to Dexie cache
    await persistTreeCache(projectId, optimistic.folders, optimistic.documents);

    const isOffline = useErrorStore.getState().isOffline;

    if (isOffline) {
      await queueTreeOp(projectId, "delete", "folder", id, {});
      return;
    }

    try {
      await removeOpsForEntity(id);
      await api.folders.delete(id);
      set({ treeLoadedAt: null });
      await useTreeStore.getState().loadTree(projectId);
    } catch (error) {
      if (isNetworkError(error)) {
        log.info("Delete folder failed (network), queueing", id);
        await queueTreeOp(projectId, "delete", "folder", id, {});
        return;
      }
      const message = getErrorMessageWithFallback(
        error,
        "Failed to delete folder",
      );
      // Server rejected the mutation (4xx/etc). Reload now to roll back optimistic state.
      set({ treeLoadedAt: null });
      try {
        await useTreeStore.getState().loadTree(projectId);
      } catch (reloadError) {
        log.warn("Failed to reload tree after delete folder rejection", reloadError);
      }
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
