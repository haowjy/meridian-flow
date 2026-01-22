import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { useProjectStore } from '@/core/stores/useProjectStore'
import { openDocument } from '@/core/lib/panelHelpers'
import { useResourceOperations, useLoadingView } from '@/core/hooks'
import { filterTree, TreeNode, generateUniqueName, getNodeNames, getFolderChildNames } from '@/core/lib/treeBuilder'
import { api } from '@/core/lib/api'
import { getErrorMessageWithFallback } from '@/core/lib/errors'
import { DocumentTreePanel } from './DocumentTreePanel'
import { FolderTreeItem } from './FolderTreeItem'
import { DocumentTreeItem } from './DocumentTreeItem'
import { SelectableTreeItem } from './SelectableTreeItem'
import { ImportDocumentDialog } from './ImportDocumentDialog'
import { DeleteFolderDialog } from './DeleteFolderDialog'
import { TreeItemInfoDialog } from './tree-item-info'
import { ProjectSettingsDialog } from '@/features/projects/components/ProjectSettingsDialog'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { InlineError } from '@/shared/components/InlineError'
import type { Folder } from '@/features/folders/types/folder'
import type { Document } from '../types/document'

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

// Info dialog state - single dialog lifted to container level
type InfoDialogItem =
  | { type: 'folder'; item: Folder; documentCount?: number; folderCount?: number }
  | { type: 'document'; item: Document }

interface DocumentTreeContainerProps {
  projectId: string
  projectSlug: string
  projectName: string | null
}

/**
 * Data layer for document tree.
 * Fetches data, handles events, renders tree structure recursively.
 */
export function DocumentTreeContainer({ projectId, projectSlug, projectName }: DocumentTreeContainerProps) {
  const navigate = useNavigate()
  const {
    tree,
    documents,
    expandedFolders,
    status,
    error,
    loadTree,
    toggleFolder,
    expandFolder,
    renameDocument,
    renameFolder,
    clearError,
  } = useTreeStore(
    useShallow((s) => ({
      tree: s.tree,
      documents: s.documents,
      expandedFolders: s.expandedFolders,
      status: s.status,
      error: s.error,
      loadTree: s.loadTree,
      toggleFolder: s.toggleFolder,
      expandFolder: s.expandFolder,
      renameDocument: s.renameDocument,
      renameFolder: s.renameFolder,
      clearError: s.clearError,
    }))
  )
  const activeDocumentId = useUIStore((state) => state.activeDocumentId)

  // Navigation-aware delete operations (handles "navigate away first" pattern)
  const { deleteDocument, deleteFolder } = useResourceOperations(projectId)

  const [searchQuery, setSearchQuery] = useState('')
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false)
  const [importTargetFolderId, setImportTargetFolderId] = useState<string | null>(null)
  const [droppedFiles, setDroppedFiles] = useState<File[]>([])
  const [editingItem, setEditingItem] = useState<EditingItem | null>(null)
  const [pendingItem, setPendingItem] = useState<PendingItem | null>(null)
  // Folder deletion confirmation state
  const [folderToDelete, setFolderToDelete] = useState<Folder | null>(null)
  const [isDeletingFolder, setIsDeletingFolder] = useState(false)

  // Info dialog state (lifted to container - single dialog for all tree items)
  const [infoDialogItem, setInfoDialogItem] = useState<InfoDialogItem | null>(null)

  // Project settings dialog state
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false)
  const { currentProject, updateProject } = useProjectStore(
    useShallow((s) => ({
      currentProject: s.currentProject,
      updateProject: s.updateProject,
    }))
  )
  const project = currentProject()

  // Derive loading view state (skeleton shows immediately on cold start)
  const view = useLoadingView({ status, hasData: tree.length > 0 })

  // Load tree on mount
  useEffect(() => {
    const abortController = new AbortController()
    loadTree(projectId, abortController.signal)

    // Cleanup: abort request if component unmounts or projectId changes
    // NOTE: In dev mode with React Strict Mode, this abort() will be called during the
    // intentional double-mount cleanup, causing an AbortError to appear in the dev mode
    // error overlay. This is EXPECTED and HARMLESS - the error is caught and handled
    // silently by useTreeStore. In production (no Strict Mode), this only runs on real
    // unmounts or project changes. The abort is necessary to prevent stale requests from
    // updating state after the component has moved on.
    return () => {
      abortController.abort()
    }
  }, [projectId, loadTree])

  // Signal right panel readiness when tree data is loaded or errors
  // This allows the layout to auto-expand the panel when data is ready
  useEffect(() => {
    const isReady = status === 'success' || status === 'error'
    useUIStore.getState().setRightPanelReady(isReady)
  }, [status])

  // --- Stable callbacks for tree items (accept id as parameter for memoization) ---

  // Handle toggle folder - stable callback for FolderTreeItem
  const handleToggleFolder = useCallback((folderId: string) => {
    toggleFolder(folderId)
  }, [toggleFolder])

  // Handle document click - stable callback for DocumentTreeItem
  const handleDocumentClick = useCallback((documentId: string) => {
    // Find document to get its slug for URL
    const doc = documents.find((d) => d.id === documentId)
    if (!doc?.slug) {
      // All documents should have slugs - this indicates a data integrity issue
      console.error('Document missing slug:', documentId)
      return
    }
    openDocument(documentId, doc.slug, projectSlug, navigate)
  }, [documents, projectSlug, navigate])

  // Handle delete document - stable callback for DocumentTreeItem
  const handleDeleteDocument = useCallback(async (documentId: string) => {
    try {
      await deleteDocument(documentId) // Hook handles navigation if needed
    } catch {
      // Error already handled by store
    }
  }, [deleteDocument])

  // Handle delete folder - show confirmation dialog (accepts id, looks up folder)
  const handleDeleteFolder = useCallback((folderId: string, folderData: Folder) => {
    setFolderToDelete(folderData)
  }, [])

  // Handle import in folder - stable callback for FolderTreeItem
  const handleImportInFolder = useCallback((folderId: string) => {
    setImportTargetFolderId(folderId)
    setIsImportDialogOpen(true)
  }, [])

  // Confirm folder deletion - actually delete
  const handleConfirmDeleteFolder = async () => {
    if (!folderToDelete) return

    setIsDeletingFolder(true)
    try {
      await deleteFolder(folderToDelete.id) // Hook handles navigation if needed
      setFolderToDelete(null)
    } catch {
      // Error already handled by store
    } finally {
      setIsDeletingFolder(false)
    }
  }

  // Handle project settings update
  const handleSettingsSubmit = useCallback(async (systemPrompt: string | null) => {
    if (!project) return
    await updateProject(project.id, { systemPrompt })
  }, [project, updateProject])

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
      // Set error in tree store for inline display
      const message = getErrorMessageWithFallback(error, `Failed to create ${pendingItem.type}`)
      useTreeStore.setState({ error: message })
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

  // Handle import documents at root level
  const handleImportRoot = () => {
    setImportTargetFolderId(null)
    setIsImportDialogOpen(true)
  }

  // Show details dialog for a folder - accepts id + data for stable callback
  const showFolderDetails = useCallback((folderId: string, folder: Folder, documentCount?: number, folderCount?: number) => {
    setInfoDialogItem({ type: 'folder', item: folder, documentCount, folderCount })
  }, [])

  // Show details dialog for a document - accepts id + data for stable callback
  const showDocumentDetails = useCallback((documentId: string, document: Document) => {
    setInfoDialogItem({ type: 'document', item: document })
  }, [])

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
      // Placeholder document data (default to markdown for new documents)
      const placeholderDocument = {
        id: pendingItem.tempId,
        name: defaultName,
        slug: '', // Placeholder - actual slug generated on server
        extension: '.md',
        filename: defaultName + '.md',
        fileType: 'markdown' as const,
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
  // Helper functions for folder metadata
  const countDocuments = (children?: TreeNode[]): number => {
    return children?.filter(c => c.type === 'document').length || 0
  }

  const countFolders = (children?: TreeNode[]): number => {
    return children?.filter(c => c.type === 'folder').length || 0
  }

  const renderTree = (nodes: TreeNode[], parentId: string | null = null) => {
    // Compute sibling names for duplicate validation
    const siblingNames = nodes.map((n) => n.data.name)

    const renderedNodes = nodes.map((node) => {
      if (node.type === 'folder') {
        const isExpanded = expandedFolders.has(node.id)
        const isEditingFolder = editingItem?.type === 'folder' && editingItem.id === node.id

        // Check if there's a pending item inside this folder
        const hasPendingChild = pendingItem?.parentId === node.id

        // Calculate folder metadata
        const documentCount = countDocuments(node.children)
        const folderCount = countFolders(node.children)

        return (
          <SelectableTreeItem key={node.id} id={node.id}>
            <FolderTreeItem
              folder={node.data}
              isExpanded={isExpanded || hasPendingChild}
              onToggle={handleToggleFolder}
              onCreateDocument={handleCreateDocumentInFolderInline}
              onCreateFolder={handleCreateFolderInFolderInline}
              onImport={handleImportInFolder}
              onRename={startRenameFolder}
              onDelete={handleDeleteFolder}
              onShowDetails={showFolderDetails}
              documentCount={documentCount}
              folderCount={folderCount}
              isEditing={isEditingFolder}
              onSubmitName={handleRenameFolderInline}
              onCancelEdit={handleCancelEdit}
              existingNames={siblingNames}
            >
              {/* Render pending item first if inside this folder */}
              {renderPendingItem(node.id, node.children ? getNodeNames(node.children) : [])}
              {node.children && node.children.length > 0 && (
                <>{renderTree(node.children, node.id)}</>
              )}
            </FolderTreeItem>
          </SelectableTreeItem>
        )
      } else {
        const isEditingDocument = editingItem?.type === 'document' && editingItem.id === node.id

        return (
          <SelectableTreeItem key={node.id} id={node.id}>
            <DocumentTreeItem
              document={node.data}
              isActive={activeDocumentId === node.id}
              onClick={handleDocumentClick}
              onRename={startRenameDocument}
              onDelete={handleDeleteDocument}
              onShowDetails={showDocumentDetails}
              isEditing={isEditingDocument}
              onSubmitName={handleRenameDocumentInline}
              onCancelEdit={handleCancelEdit}
              existingNames={siblingNames}
            />
          </SelectableTreeItem>
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

  // Loading state - show empty container for cold loads (no cached data)
  if (view === 'skeleton') {
    return <div className="flex h-full flex-col" />
  }

  // Error state - only show full error panel when we have no cached tree to display
  if (view === 'error') {
    return (
      <>
        <DocumentTreePanel
          title={projectName ?? undefined}
          onCreateDocument={handleCreateRootDocumentInline}
          onCreateFolder={handleCreateRootFolderInline}
          onImport={handleImportRoot}
          onSearch={setSearchQuery}
          isEmpty={false}
          projectId={projectId}
          onBulkOperationComplete={() => loadTree(projectId)}
          deleteDocument={deleteDocument}
          deleteFolder={deleteFolder}
          onOpenSettings={() => setIsSettingsDialogOpen(true)}
        >
          <ErrorPanel
            title="Failed to load documents"
            message={error || 'Unknown error'}
            onRetry={() => loadTree(projectId)}
          />
        </DocumentTreePanel>

        <ProjectSettingsDialog
          project={project}
          open={isSettingsDialogOpen}
          onOpenChange={setIsSettingsDialogOpen}
          onSubmit={handleSettingsSubmit}
        />
      </>
    )
  }

  // Filter tree by search query
  const filteredTree = filterTree(tree, searchQuery)
  // Treat the tree as non-empty while a pending item is being created so that
  // the inline editor can be rendered instead of the zero-state panel.
  const isEmpty = tree.length === 0 && !pendingItem

  // Show inline error for operations that failed (e.g., create/rename/delete)
  // but only when we have tree data (otherwise full ErrorPanel shown above)
  const hasOperationError = error && tree.length > 0

  return (
    <>
      <DocumentTreePanel
        title={projectName ?? undefined}
        onCreateDocument={handleCreateRootDocumentInline}
        onCreateFolder={handleCreateRootFolderInline}
        onImport={handleImportRoot}
        onFileDrop={handleFileDrop}
        onSearch={setSearchQuery}
        isEmpty={isEmpty}
        projectId={projectId}
        onBulkOperationComplete={() => loadTree(projectId)}
        deleteDocument={deleteDocument}
        deleteFolder={deleteFolder}
        onOpenSettings={() => setIsSettingsDialogOpen(true)}
      >
        {hasOperationError && (
          <div className="mb-2">
            <InlineError message={error} onDismiss={clearError} />
          </div>
        )}
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

      <DeleteFolderDialog
        folder={folderToDelete}
        open={folderToDelete !== null}
        onOpenChange={(open) => !open && setFolderToDelete(null)}
        onConfirm={handleConfirmDeleteFolder}
        isDeleting={isDeletingFolder}
      />

      {/* Single info dialog for all tree items (lifted to container level for performance) */}
      {infoDialogItem?.type === 'folder' && (
        <TreeItemInfoDialog
          open={true}
          onOpenChange={(open) => !open && setInfoDialogItem(null)}
          item={infoDialogItem.item}
          type="folder"
          documentCount={infoDialogItem.documentCount}
          folderCount={infoDialogItem.folderCount}
        />
      )}
      {infoDialogItem?.type === 'document' && (
        <TreeItemInfoDialog
          open={true}
          onOpenChange={(open) => !open && setInfoDialogItem(null)}
          item={infoDialogItem.item}
          type="document"
        />
      )}

      <ProjectSettingsDialog
        project={project}
        open={isSettingsDialogOpen}
        onOpenChange={setIsSettingsDialogOpen}
        onSubmit={handleSettingsSubmit}
      />
    </>
  )
}
