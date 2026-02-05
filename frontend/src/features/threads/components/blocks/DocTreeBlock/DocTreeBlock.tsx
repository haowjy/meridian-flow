/**
 * DocTreeBlock - Visual representation of doc_tree tool interactions
 *
 * Displays project tree structure with:
 * - Collapsible folder hierarchy using FolderTreeView
 * - Status badge (Pending/Traversed/Error)
 * - Document clicks navigate to editor
 *
 * Uses the same FolderTreeView component as DocViewBlock for consistency.
 */

import React, { useState, useCallback, useEffect } from 'react'
import { useNavigate, useLocation } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import { FolderTree, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TurnBlock, ToolBlockContent } from '@/features/threads/types'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { findFolderByPath } from '@/features/threads/utils/docPathResolver'
import { openDocument } from '@/core/lib/panelHelpers'
import {
  CollapsibleToolBlock,
  ToolStatusBadge,
  FolderTreeView,
  useToolStreamingState,
  type ToolStatus,
} from '../shared'
import { ToolStreamState } from '@/features/threads/stores/useToolStreamStore'
import type { Document } from '@/features/documents/types/document'
import type { DocTreeInput, DocTreeResult } from './types'

// =============================================================================
// TYPES
// =============================================================================

interface DocTreeBlockProps {
  toolUse: TurnBlock | null
  toolResult: TurnBlock | null
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract DocTreeInput from tool_use block.
 */
function getDocTreeInput(toolUse: TurnBlock | null): DocTreeInput | null {
  if (!toolUse) return null
  const content = toolUse.content as ToolBlockContent
  const input = content?.input as DocTreeInput | undefined
  return input ?? null
}

/**
 * Extract result from tool_result block.
 */
function getDocTreeResult(toolResult: TurnBlock | null): {
  result: DocTreeResult | null
  isError: boolean
  errorMessage?: string
} {
  if (!toolResult) return { result: null, isError: false }
  const content = toolResult.content as ToolBlockContent

  // Check for error
  if (content?.isError) {
    const message =
      typeof content.message === 'string'
        ? content.message
        : typeof content.error === 'string'
          ? content.error
          : 'Unknown error'
    return { result: null, isError: true, errorMessage: message }
  }

  // Result is nested under content.result
  const possibleResult = (content as Record<string, unknown>)?.result ?? content
  const result = possibleResult as unknown as DocTreeResult

  if (result?.type === 'tree') {
    return { result, isError: false }
  }

  return { result: null, isError: false }
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const DocTreeBlock = React.memo(function DocTreeBlock({
  toolUse,
  toolResult,
}: DocTreeBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const navigate = useNavigate()

  // Get tree data for resolution and rendering
  const { documents, folders } = useTreeStore(
    useShallow((s) => ({
      documents: s.documents,
      folders: s.folders,
    }))
  )

  // Get project slug from URL for navigation
  const location = useLocation()
  const projectSlug = location.pathname.match(/^\/projects\/([^/]+)/)?.[1] || null

  // Get streaming state for animation control via dedicated hook
  const { isGenerating: toolIsGenerating, state: toolState } = useToolStreamingState({
    blockContent: toolUse?.content as ToolBlockContent | undefined,
  })

  // Parse input and result
  const input = getDocTreeInput(toolUse)
  const { result, isError, errorMessage } = getDocTreeResult(toolResult)
  const hasResult = !!toolResult

  // Hydrate tree store when result arrives (so FolderTreeView can render)
  useEffect(() => {
    if (result && !isError && result.folders && result.documents) {
      useTreeStore.getState().hydrateFromToolResult(
        result.folders,
        result.documents
      )
    }
  }, [result, isError])

  // Resolve folder from tree store
  // Use result.path (resolved path) if available, otherwise input.path or legacy input.folder
  const folderPath = result?.path ?? input?.path ?? input?.folder ?? '/'
  const resolvedFolder = findFolderByPath(folderPath, folders)

  // Get folder ID for FolderTreeView (null = root, string = folder ID)
  const rootFolderId =
    resolvedFolder === null
      ? null // Root folder
      : resolvedFolder?.id ?? null

  // Handle document click - navigate to editor
  const handleDocumentClick = useCallback(
    (doc: Document) => {
      if (!projectSlug) return
      openDocument(doc.id, doc.path, projectSlug, navigate)
    },
    [projectSlug, navigate]
  )

  // Build display path
  const displayPath = folderPath === '/' ? '/' : folderPath

  // Get depth from result or input
  const depth = result?.depth ?? input?.depth ?? 2

  // Determine status for badge
  let status: ToolStatus
  let statusLabel: string
  if (isError) {
    status = 'error'
    statusLabel = 'Error'
  } else if (hasResult) {
    status = 'success'
    statusLabel = 'Traversed'
  } else {
    status = 'pending'
    statusLabel = 'Pending...'
  }

  return (
    <CollapsibleToolBlock
      icon={FolderTree}
      label={
        <>
          <span className="text-sm font-medium text-foreground/90 shrink-0">Tree</span>
          <span className="text-sm font-normal text-muted-foreground truncate min-w-0 @[200px]:inline hidden">
            {displayPath}
          </span>
          <span className="ml-1 text-xs text-muted-foreground/60 shrink-0 @[250px]:inline hidden">
            (depth: {depth})
          </span>
        </>
      }
      statusBadge={<ToolStatusBadge status={status} label={statusLabel} />}
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      // Animation: shimmer during PREPARING (args streaming) or when pending (no state yet)
      // Stops when tool args are complete (state becomes 'ready') or result arrives
      isGenerating={!hasResult && !isError && (toolState === null || toolIsGenerating)}
      // Pulse animation during EXECUTING (tool running on backend)
      isExecuting={!hasResult && !isError && toolState === ToolStreamState.EXECUTING}
    >
      {/* Error message */}
      {isError && errorMessage && (
        <div
          className={cn(
            'flex items-start gap-2',
            'text-xs p-2.5 rounded-md',
            'bg-error/15 text-error'
          )}
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="leading-relaxed">{errorMessage}</span>
        </div>
      )}

      {/* Folder tree view */}
      {hasResult && !isError && (
        <FolderTreeView
          rootFolderId={rootFolderId}
          folders={folders}
          documents={documents}
          onDocumentClick={handleDocumentClick}
          showWordCount={true}
        />
      )}

      {/* Blank space during pending state (before streaming starts) for consistent UX */}
      {!hasResult && !isError && toolState === null && (
        <div className="py-2" />
      )}
    </CollapsibleToolBlock>
  )
})
