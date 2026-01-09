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

import React, { useState, useCallback } from 'react'
import { useNavigate, useLocation } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import { FolderTree, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TurnBlock, ToolBlockContent } from '@/features/chats/types'
import { useTreeStore } from '@/core/stores/useTreeStore'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/shared/components/ui/collapsible'
import { findFolderByPath } from '@/features/chats/utils/docPathResolver'
import { openDocument } from '@/core/lib/panelHelpers'
import { FolderTreeView } from '../shared'
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
  if (content?.is_error) {
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

  // Parse input and result
  const input = getDocTreeInput(toolUse)
  const { result, isError, errorMessage } = getDocTreeResult(toolResult)
  const hasResult = !!toolResult

  // Resolve folder from tree store
  // Use result.path (resolved path) if available, otherwise input.folder
  const folderPath = result?.path ?? input?.folder ?? '/'
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
      openDocument(doc.id, doc.slug, projectSlug, navigate)
    },
    [projectSlug, navigate]
  )

  // Build display path
  const displayPath = folderPath === '/' ? '/' : folderPath

  // Get depth from result or input
  const depth = result?.depth ?? input?.depth ?? 2

  // Status styling
  let statusLabel: string
  let statusClass: string
  if (isError) {
    statusLabel = 'Error'
    statusClass =
      'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700'
  } else if (hasResult) {
    statusLabel = 'Traversed'
    statusClass =
      'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700'
  } else {
    statusLabel = 'Pending...'
    statusClass = 'bg-muted text-muted-foreground border-muted-foreground/30'
  }

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <div
        className={cn(
          'rounded-lg border',
          'bg-card/50 hover:bg-card/80',
          'transition-colors duration-150',
          'overflow-hidden'
        )}
      >
        {/* Header - clickable to expand/collapse */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex w-full items-center gap-2 px-3 py-2',
              'text-left cursor-pointer',
              'hover:bg-muted/50 transition-colors'
            )}
          >
            {/* Icon */}
            <FolderTree className="h-3 w-3 shrink-0 text-muted-foreground/70" />

            {/* Path and depth info */}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-sm font-medium text-foreground/90 truncate">
                Tree:{' '}
                <span className="text-muted-foreground font-normal">
                  {displayPath}
                </span>
                <span className="text-muted-foreground/60 font-normal text-xs ml-1">
                  (depth: {depth})
                </span>
              </span>
            </div>

            {/* Status badge */}
            <span
              className={cn(
                'shrink-0 text-[11px] font-medium',
                'px-2 py-0.5 rounded-full border',
                statusClass
              )}
            >
              {statusLabel}
            </span>
          </button>
        </CollapsibleTrigger>

        {/* Expanded content */}
        <CollapsibleContent>
          <div className="border-t px-3 py-3 space-y-2">
            {/* Error message */}
            {isError && errorMessage && (
              <div
                className={cn(
                  'flex items-start gap-2',
                  'text-xs p-2.5 rounded-md',
                  'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
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

            {/* Pending state */}
            {!hasResult && !isError && (
              <div className="text-xs text-muted-foreground italic py-2">
                Loading tree...
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
})
