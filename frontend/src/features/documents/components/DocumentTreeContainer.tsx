'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useShallow } from 'zustand/react/shallow'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { openDocument } from '@/core/lib/panelHelpers'
import { useResourceOperations } from '@/core/hooks'
import { filterTree, TreeNode, generateUniqueName, getNodeNames, getFolderChildNames } from '@/core/lib/treeBuilder'
import { api } from '@/core/lib/api'
import { handleApiError } from '@/core/lib/errors'
import { DocumentTreePanel } from './DocumentTreePanel'
import { FolderTreeItem } from './FolderTreeItem'
import { DocumentTreeItem } from './DocumentTreeItem'
import { ImportDocumentDialog } from './ImportDocumentDialog'
import { Skeleton } from '@/shared/components/ui/skeleton'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { useProjectStore } from '@/core/stores/useProjectStore'

// Tracks which tree item is being edited (existing items only)
interface EditingItem {
  type: 'document' | 'folder'
  id: string
}

// Visual placeholder for new items (not yet created in backend)
interface PendingItem {
  type: 'document' | 'folder'
  parentId: string | null  // null = root level
  tempId: string           // for React key
}

interface DocumentTreeContainerProps {
  projectId: string
}

/**
 * Data layer for document tree.
 * Fetches data, handles events, renders tree structure recursively.
 */
export function DocumentTreeContainer({ projectId }: DocumentTreeContainerProps) {
  const router = useRouter()
  const {
    tree,
    expandedFolders,
    status,
    error,
    loadTree,
    toggleFolder,
    expandFolder,
    renameDocument,
    renameFolder,
  } = useTreeStore(
    useShallow((s) => ({
      tree: s.tree,
      expandedFolders: s.expandedFolders,
      status: s.status,
      error: s.error,
      loadTree: s.loadTree,
      toggleFolder: s.toggleFolder,
      expandFolder: s.expandFolder,
      renameDocument: s.renameDocument,
      renameFolder: s.renameFolder,
    }))
  )
  const activeDocumentId = useUIStore((state) => state.activeDocumentId)

  // Navigation-aware delete operations (handles "navigate away first" pattern)
  const { deleteDocument, deleteFolder } = useResourceOperations(projectId)

  // Read project name from store for header title (centralized approach)
  const projectName = useProjectStore((s) =>
    s.projects.find((p) => p.id === projectId)?.name || s.currentProject()?.name || undefined
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false)
  const [importTargetFolderId, setImportTargetFolderId] = useState<string | null>(null)
  const [droppedFiles, setDroppedFiles] = useState<File[]>([])
  const [showSkeleton, setShowSkeleton] = useState(false)
  const [editingItem, setEditingItem] = useState<EditingItem | null>(null)
  const [pendingItem, setPendingItem] = useState<PendingItem | null>(null)

  // Load tree on mount
  useEffect(() => {
    const abortController = new AbortController()
    loadTree(projectId, abortController.signal)

    // Cleanup: abort request if component unmounts or projectId changes
    // NOTE: In dev mode with React Strict Mode, this abort() will be called during the
    // intentional double-mount cleanup, causing an AbortError to appear in the Next.js
    // error overlay. This is EXPECTED and HARMLESS - the error is caught and handled
    // silently by useTreeStore. In production (no Strict Mode), this only runs on real
    // unmounts or project changes. The abort is necessary to prevent stale requests from
    // updating state after the component has moved on.
    return () => {
      abortController.abort()
    }
  }, [projectId, loadTree])

  // Skeleton delay: only show skeleton after 150ms if still loading
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null

    if (status === 'loading') {
      timer = setTimeout(() => setShowSkeleton(true), 150)
    }

    return () => {
      if (timer) clearTimeout(timer)
      setShowSkeleton(false)
    }
  }, [status])

  // Handle document click
  const handleDocumentClick = (documentId: string) => {
    openDocument(documentId, projectId, router)
  }

  // Handle delete document
  const handleDeleteDocument = async (documentId: string) => {
    try {
      await deleteDocument(documentId) // Hook handles navigation if needed
    } catch {
      // Error already handled by store
    }
  }

  // Handle delete folder
  const handleDeleteFolder = async (folderId: string) => {
    try {
      await deleteFolder(folderId) // Hook handles navigation if needed
    } catch {
      // Error already handled by store
    }
  }

  // --- Inline rename handlers ---

  // Start renaming an existing document
  const startRenameDocument = useCallback((documentId: string) => {
    setEditingItem({ type: 'document', id: documentId })
  }, [])

  // Start renaming an existing folder
  const startRenameFolder = useCallback((folderId: string) => {
    setEditingItem({ type: 'folder', id: folderId })
  }, [])

  // Submit inline rename for document
  const handleRenameDocumentInline = useCallback(async (documentId: string, name: string) => {
    try {
      await renameDocument(documentId, name, projectId)
    } catch {
      // Error already handled by store
    } finally {
      setEditingItem(null)
    }
  }, [renameDocument, projectId])

  // Submit inline rename for folder
  const handleRenameFolderInline = useCallback(async (folderId: string, name: string) => {
    try {
      await renameFolder(folderId, name, projectId)
    } catch {
      // Error already handled by store
    } finally {
      setEditingItem(null)
    }
  }, [renameFolder, projectId])

  // Cancel editing - just clear state (no backend calls needed)
  const handleCancelEdit = useCallback(() => {
    setPendingItem(null)
    setEditingItem(null)
  }, [])

  // Submit new item - create in backend with entered name
  const handleSubmitNewItem = useCallback(async (name: string) => {
    if (!pendingItem) return

    const trimmedName = name.trim()
    if (!trimmedName) {
      // Empty name - just cancel
      setPendingItem(null)
      setEditingItem(null)
      return
    }

    // Get sibling names for unique name generation
    const siblingNames = pendingItem.parentId
      ? getFolderChildNames(tree, pendingItem.parentId)
      : getNodeNames(tree)
    const uniqueName = generateUniqueName(trimmedName, siblingNames)

    try {
      if (pendingItem.type === 'folder') {
        await api.folders.create(projectId, pendingItem.parentId, uniqueName)
      } else {
        await api.documents.create(projectId, pendingItem.parentId, uniqueName)
      }
      await loadTree(projectId)
    } catch (error) {
      handleApiError(error, `Failed to create ${pendingItem.type}`)
    } finally {
      setPendingItem(null)
      setEditingItem(null)
    }
  }, [pendingItem, tree, projectId, loadTree])

  // --- Inline create handlers (show placeholder, no backend call) ---

  // Create root-level document placeholder
  const handleCreateRootDocumentInline = useCallback(() => {
    const tempId = `pending-${Date.now()}`
    setPendingItem({ type: 'document', parentId: null, tempId })
    setEditingItem({ type: 'document', id: tempId })
  }, [])

  // Create root-level folder placeholder
  const handleCreateRootFolderInline = useCallback(() => {
    const tempId = `pending-${Date.now()}`
    setPendingItem({ type: 'folder', parentId: null, tempId })
    setEditingItem({ type: 'folder', id: tempId })
  }, [])

  // Create document placeholder inside folder
  const handleCreateDocumentInFolderInline = useCallback((folderId: string) => {
    const tempId = `pending-${Date.now()}`
    setPendingItem({ type: 'document', parentId: folderId, tempId })
    setEditingItem({ type: 'document', id: tempId })
    expandFolder(folderId)
  }, [expandFolder])

  // Create folder placeholder inside folder
  const handleCreateFolderInFolderInline = useCallback((parentId: string) => {
    const tempId = `pending-${Date.now()}`
    setPendingItem({ type: 'folder', parentId, tempId })
    setEditingItem({ type: 'folder', id: tempId })
    expandFolder(parentId)
  }, [expandFolder])

  // Handle import documents in folder
  const handleImportInFolder = (folderId: string) => {
    setImportTargetFolderId(folderId)
    setIsImportDialogOpen(true)
  }

  // Handle import documents at root level
  const handleImportRoot = () => {
    setImportTargetFolderId(null)
    setIsImportDialogOpen(true)
  }

  // Handle files dropped on empty state
  const handleFileDrop = (files: File[]) => {
    setDroppedFiles(files)
    setImportTargetFolderId(null)
    setIsImportDialogOpen(true)
  }

  // Clear dropped files when dialog closes
  const handleImportDialogChange = (open: boolean) => {
    setIsImportDialogOpen(open)
    if (!open) {
      setDroppedFiles([])
    }
  }

  // Handle import complete - just refresh tree, dialog handles its own closing
  const handleImportComplete = () => {
    loadTree(projectId)
  }

  // Render a pending item placeholder (new item not yet created)
  const renderPendingItem = (parentId: string | null, siblingNames: string[]) => {
    if (!pendingItem || pendingItem.parentId !== parentId) return null

    const isEditingPending = editingItem?.id === pendingItem.tempId

    // Compute unique default name based on type (auto-increments if duplicate exists)
    const defaultName = pendingItem.type === 'folder'
      ? generateUniqueName('New Folder', siblingNames)
      : generateUniqueName('Untitled', siblingNames)

    if (pendingItem.type === 'folder') {
      // Placeholder folder data
      const placeholderFolder = {
        id: pendingItem.tempId,
        name: defaultName,
        projectId: projectId,
        parentId: parentId,
        createdAt: new Date(),
      }

      return (
        <FolderTreeItem
          key={pendingItem.tempId}
          folder={placeholderFolder}
          isExpanded={false}
          onToggle={() => {}}
          onCreateDocument={() => {}}
          onCreateFolder={() => {}}
          onImport={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          isEditing={isEditingPending}
          onSubmitName={handleSubmitNewItem}
          onCancelEdit={handleCancelEdit}
          existingNames={siblingNames}
          editorMode="create"
        >
          {null}
        </FolderTreeItem>
      )
    } else {
      // Placeholder document data
      const placeholderDocument = {
        id: pendingItem.tempId,
        name: defaultName,
        projectId: projectId,
        folderId: parentId,
        content: '',
        wordCount: 0,
        updatedAt: new Date(),
      }

      return (
        <DocumentTreeItem
          key={pendingItem.tempId}
          document={placeholderDocument}
          isActive={false}
          onClick={() => {}}
          onRename={() => {}}
          onDelete={() => {}}
          isEditing={isEditingPending}
          onSubmitName={handleSubmitNewItem}
          onCancelEdit={handleCancelEdit}
          existingNames={siblingNames}
          editorMode="create"
        />
      )
    }
  }

  // Render tree recursively
  const renderTree = (nodes: TreeNode[], parentId: string | null = null) => {
    // Compute sibling names for duplicate validation
    const siblingNames = nodes.map((n) => n.data.name)

    const renderedNodes = nodes.map((node) => {
      if (node.type === 'folder') {
        const isExpanded = expandedFolders.has(node.id)
        const isEditingFolder = editingItem?.type === 'folder' && editingItem.id === node.id

        // Check if there's a pending item inside this folder
        const hasPendingChild = pendingItem?.parentId === node.id

        return (
          <FolderTreeItem
            key={node.id}
            folder={node.data}
            isExpanded={isExpanded || hasPendingChild}
            onToggle={() => toggleFolder(node.id)}
            onCreateDocument={() => handleCreateDocumentInFolderInline(node.id)}
            onCreateFolder={() => handleCreateFolderInFolderInline(node.id)}
            onImport={() => handleImportInFolder(node.id)}
            onRename={() => startRenameFolder(node.id)}
            onDelete={() => handleDeleteFolder(node.id)}
            isEditing={isEditingFolder}
            onSubmitName={(name) => handleRenameFolderInline(node.id, name)}
            onCancelEdit={handleCancelEdit}
            existingNames={siblingNames}
          >
            {/* Render pending item first if inside this folder */}
            {renderPendingItem(node.id, node.children ? getNodeNames(node.children) : [])}
            {node.children && node.children.length > 0 && (
              <>{renderTree(node.children, node.id)}</>
            )}
          </FolderTreeItem>
        )
      } else {
        const isEditingDocument = editingItem?.type === 'document' && editingItem.id === node.id

        return (
          <DocumentTreeItem
            key={node.id}
            document={node.data}
            isActive={activeDocumentId === node.id}
            onClick={() => handleDocumentClick(node.id)}
            onRename={() => startRenameDocument(node.id)}
            onDelete={() => handleDeleteDocument(node.id)}
            isEditing={isEditingDocument}
            onSubmitName={(name) => handleRenameDocumentInline(node.id, name)}
            onCancelEdit={handleCancelEdit}
            existingNames={siblingNames}
          />
        )
      }
    })

    // For root level, render pending item at the top
    if (parentId === null) {
      return (
        <>
          {renderPendingItem(null, siblingNames)}
          {renderedNodes}
        </>
      )
    }

    return renderedNodes
  }

  // Loading state - show skeleton only for true cold loads (no cached data)
  if (status === 'loading' && showSkeleton) {
    return (
      <div className="flex h-full flex-col">
        <div className="px-3 py-2">
          <Skeleton className="h-8 w-32" />
        </div>
        <div className="space-y-2 p-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-56" />
        </div>
      </div>
    )
  }

  // Error state - only show error when we have no cached tree to display
  if (status === 'error' && tree.length === 0) {
    return (
      <DocumentTreePanel
        title={projectName || undefined}
        onCreateDocument={handleCreateRootDocumentInline}
        onCreateFolder={handleCreateRootFolderInline}
        onImport={handleImportRoot}
        onSearch={setSearchQuery}
        isEmpty={false}
      >
        <ErrorPanel
          title="Failed to load documents"
          message={error || 'Unknown error'}
          onRetry={() => loadTree(projectId)}
        />
      </DocumentTreePanel>
    )
  }

  // Filter tree by search query
  const filteredTree = filterTree(tree, searchQuery)
  // Treat the tree as non-empty while a pending item is being created so that
  // the inline editor can be rendered instead of the zero-state panel.
  const isEmpty = tree.length === 0 && !pendingItem

  return (
    <>
      <DocumentTreePanel
        title={projectName || undefined}
        onCreateDocument={handleCreateRootDocumentInline}
        onCreateFolder={handleCreateRootFolderInline}
        onImport={handleImportRoot}
        onFileDrop={handleFileDrop}
        onSearch={setSearchQuery}
        isEmpty={isEmpty}
      >
        {renderTree(filteredTree)}
      </DocumentTreePanel>

      <ImportDocumentDialog
        open={isImportDialogOpen}
        onOpenChange={handleImportDialogChange}
        projectId={projectId}
        folderId={importTargetFolderId}
        onComplete={handleImportComplete}
        initialFiles={droppedFiles}
      />
    </>
  )
}
