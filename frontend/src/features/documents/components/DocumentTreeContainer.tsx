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
  const { tree, folders, expandedFolders, isLoading, error, loadTree, toggleFolder } = useTreeStore(
    useShallow((s) => ({
      tree: s.tree,
      folders: s.folders,
      expandedFolders: s.expandedFolders,
      isLoading: s.isLoading,
      error: s.error,
      loadTree: s.loadTree,
      toggleFolder: s.toggleFolder,
    }))
  )
  const activeDocumentId = useUIStore((state) => state.activeDocumentId)

  // Read project name from store for header title (centralized approach)
  const projectName = useProjectStore((s) =>
    s.projects.find((p) => p.id === projectId)?.name || s.currentProject()?.name || undefined
  )

  const [searchQuery, setSearchQuery] = useState('')
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)

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
      if (isAppError(error) && error.type === 'CONFLICT' && (error.resource as any)?.id) {
        const existingId = (error.resource as any).id as string
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
        onCreateDocument={() => setIsCreateDialogOpen(true)}
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
        onCreateDocument={() => setIsCreateDialogOpen(true)}
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
    </>
  )
}
