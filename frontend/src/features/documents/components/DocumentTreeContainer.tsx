'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useShallow } from 'zustand/react/shallow'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { openDocument } from '@/core/lib/panelHelpers'
import { filterTree, TreeNode } from '@/core/lib/treeBuilder'
import { api } from '@/core/lib/api'
import { toast } from 'sonner'
import { handleApiError, isAppError } from '@/core/lib/errors'
import { DocumentTreePanel } from './DocumentTreePanel'
import { FolderTreeItem } from './FolderTreeItem'
import { DocumentTreeItem } from './DocumentTreeItem'
import { CreateDocumentDialog } from './CreateDocumentDialog'
import { ImportDocumentDialog } from './ImportDocumentDialog'
import { CardSkeleton } from '@/shared/components/ui/card'
import { ErrorPanel } from '@/shared/components/ErrorPanel'
import { useProjectStore } from '@/core/stores/useProjectStore'

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
    folders,
    documents,
    expandedFolders,
    isLoading,
    error,
    loadTree,
    toggleFolder,
    createDocument,
    createFolder,
    deleteDocument,
    deleteFolder,
    renameDocument,
    renameFolder,
  } = useTreeStore(
    useShallow((s) => ({
      tree: s.tree,
      folders: s.folders,
      documents: s.documents,
      expandedFolders: s.expandedFolders,
      isLoading: s.isLoading,
      error: s.error,
      loadTree: s.loadTree,
      toggleFolder: s.toggleFolder,
      createDocument: s.createDocument,
      createFolder: s.createFolder,
      deleteDocument: s.deleteDocument,
      deleteFolder: s.deleteFolder,
      renameDocument: s.renameDocument,
      renameFolder: s.renameFolder,
    }))
  )
  const activeDocumentId = useUIStore((state) => state.activeDocumentId)

  // Read project name from store for header title (centralized approach)
  const projectName = useProjectStore((s) =>
    s.projects.find((p) => p.id === projectId)?.name || s.currentProject()?.name || undefined
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false)
  const [importTargetFolderId, setImportTargetFolderId] = useState<string | null>(null)

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

  // Handle document click
  const handleDocumentClick = (documentId: string) => {
    openDocument(documentId, projectId, router)
  }

  // Handle create document
  const handleCreateDocument = async (name: string, folderId?: string) => {
    try {
      await api.documents.create(projectId, folderId || null, name)
      toast.success('Document created')

      // Reload tree to show new document
      await loadTree(projectId)
    } catch (error) {
      // Special-case conflicts to offer navigating to the existing document
      if (isAppError(error) && error.type === 'CONFLICT') {
        const resource = error.resource as { id?: string } | undefined
        const existingId = resource?.id
        if (!existingId) {
          handleApiError(error, 'Failed to create document')
          throw error
        }
        toast.error(error.message || 'Resource already exists.', {
          action: {
            label: 'Open',
            onClick: () => handleDocumentClick(existingId),
          },
        })
      } else {
        handleApiError(error, 'Failed to create document')
      }
      throw error // Re-throw so dialog can handle
    }
  }

  // Handle delete document
  const handleDeleteDocument = async (documentId: string) => {
    try {
      await deleteDocument(documentId, projectId)
      toast.success('Document deleted')
    } catch {
      // Error already handled by store
    }
  }

  // Handle create document in folder
  const handleCreateDocumentInFolder = async (folderId: string) => {
    const folderName = folders.find((f) => f.id === folderId)?.name || 'folder'
    const documentName = prompt(`Enter document name (in ${folderName}):`)
    if (!documentName) return

    try {
      await createDocument(projectId, folderId, documentName)
      toast.success('Document created')
    } catch {
      // Error already handled by store
    }
  }

  // Handle create folder in folder
  const handleCreateFolderInFolder = async (parentId: string) => {
    const parentName = folders.find((f) => f.id === parentId)?.name || 'folder'
    const folderName = prompt(`Enter folder name (in ${parentName}):`)
    if (!folderName) return

    try {
      await createFolder(projectId, parentId, folderName)
      toast.success('Folder created')
    } catch {
      // Error already handled by store
    }
  }

  // Handle delete folder
  const handleDeleteFolder = async (folderId: string) => {
    try {
      await deleteFolder(folderId, projectId)
      toast.success('Folder deleted')
    } catch {
      // Error already handled by store
    }
  }

  // Handle rename document
  const handleRenameDocument = async (documentId: string) => {
    const document = documents.find((d) => d.id === documentId)
    if (!document) return

    const newName = prompt('Enter new document name:', document.name)
    if (!newName || newName === document.name) return

    try {
      await renameDocument(documentId, newName, projectId)
      toast.success('Document renamed')
    } catch {
      // Error already handled by store
    }
  }

  // Handle rename folder
  const handleRenameFolder = async (folderId: string) => {
    const folder = folders.find((f) => f.id === folderId)
    if (!folder) return

    const newName = prompt('Enter new folder name:', folder.name)
    if (!newName || newName === folder.name) return

    try {
      await renameFolder(folderId, newName, projectId)
      toast.success('Folder renamed')
    } catch {
      // Error already handled by store
    }
  }

  // Handle create root-level document
  const handleCreateRootDocument = () => {
    setIsCreateDialogOpen(true)
  }

  // Handle create root-level folder
  const handleCreateRootFolder = async () => {
    const folderName = prompt('Enter folder name:')
    if (!folderName) return

    try {
      await createFolder(projectId, null, folderName)
      toast.success('Folder created')
    } catch {
      // Error already handled by store
    }
  }

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

  // Handle import complete
  const handleImportComplete = () => {
    // Refresh tree after successful import
    loadTree(projectId)
    setIsImportDialogOpen(false)
  }

  // Render tree recursively
  const renderTree = (nodes: TreeNode[]) => {
    return nodes.map((node) => {
      if (node.type === 'folder') {
        const isExpanded = expandedFolders.has(node.id)

        return (
          <FolderTreeItem
            key={node.id}
            folder={node.data} // TypeScript narrows to Folder based on discriminated union
            isExpanded={isExpanded}
            onToggle={() => toggleFolder(node.id)}
            onCreateDocument={() => handleCreateDocumentInFolder(node.id)}
            onCreateFolder={() => handleCreateFolderInFolder(node.id)}
            onImport={() => handleImportInFolder(node.id)}
            onRename={() => handleRenameFolder(node.id)}
            onDelete={() => handleDeleteFolder(node.id)}
          >
            {node.children && node.children.length > 0 && (
              <>{renderTree(node.children)}</>
            )}
          </FolderTreeItem>
        )
      } else {
        return (
          <DocumentTreeItem
            key={node.id}
            document={node.data} // TypeScript narrows to Document based on discriminated union
            isActive={activeDocumentId === node.id}
            onClick={() => handleDocumentClick(node.id)}
            onRename={() => handleRenameDocument(node.id)}
            onDelete={() => handleDeleteDocument(node.id)}
          />
        )
      }
    })
  }

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="px-3 py-2">
          <CardSkeleton className="h-8" />
        </div>
        <div className="space-y-2 p-4">
          <CardSkeleton className="h-10" />
          <CardSkeleton className="h-10" />
          <CardSkeleton className="h-10" />
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <DocumentTreePanel
        title={projectName || undefined}
        onCreateDocument={handleCreateRootDocument}
        onCreateFolder={handleCreateRootFolder}
        onImport={handleImportRoot}
        onSearch={setSearchQuery}
        isEmpty={false}
      >
        <ErrorPanel
          title="Failed to load documents"
          message={error}
          onRetry={() => loadTree(projectId)}
        />
      </DocumentTreePanel>
    )
  }

  // Filter tree by search query
  const filteredTree = filterTree(tree, searchQuery)
  const isEmpty = tree.length === 0

  return (
    <>
      <DocumentTreePanel
        title={projectName || undefined}
        onCreateDocument={handleCreateRootDocument}
        onCreateFolder={handleCreateRootFolder}
        onImport={handleImportRoot}
        onSearch={setSearchQuery}
        isEmpty={isEmpty}
      >
        {renderTree(filteredTree)}
      </DocumentTreePanel>

      <CreateDocumentDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        onCreate={handleCreateDocument}
        folders={folders}
      />

      <ImportDocumentDialog
        open={isImportDialogOpen}
        onOpenChange={setIsImportDialogOpen}
        projectId={projectId}
        folderId={importTargetFolderId}
        onComplete={handleImportComplete}
      />
    </>
  )
}
