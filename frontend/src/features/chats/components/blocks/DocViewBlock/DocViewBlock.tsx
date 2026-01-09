/**
 * DocViewBlock - Visual representation of doc_view tool interactions
 *
 * Displays document view operations with:
 * - Collapsible content preview (documents) or folder listing (folders)
 * - Status badge (Pending/Read/Error)
 * - "View" button to navigate to document/folder
 *
 * Uses the tool registry pattern for extensibility.
 */

import React, { useState, useCallback } from 'react'
import { useNavigate, useLocation } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import { FileText, FolderOpen, ExternalLink, AlertCircle, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TurnBlock, ToolBlockContent } from '@/features/chats/types'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { Button } from '@/shared/components/ui/button'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/shared/components/ui/collapsible'
import {
  parseDocEditPath,
  findDocumentByPath,
  findFolderByPath,
} from '@/features/chats/utils/docPathResolver'
import { openDocument } from '@/core/lib/panelHelpers'
import { FolderTreeView } from '../shared'
import type { Document } from '@/features/documents/types/document'
import type { DocViewInput, DocViewResult, DocViewDocumentResult, DocViewFolderResult } from './types'

// =============================================================================
// TYPES
// =============================================================================

interface DocViewBlockProps {
  toolUse: TurnBlock | null
  toolResult: TurnBlock | null
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract DocViewInput from tool_use block.
 */
function getDocViewInput(toolUse: TurnBlock | null): DocViewInput | null {
  if (!toolUse) return null
  const content = toolUse.content as ToolBlockContent
  const input = content?.input as DocViewInput | undefined
  if (!input || !input.path) return null
  return input
}

/**
 * Extract result from tool_result block.
 */
function getDocViewResult(toolResult: TurnBlock | null): {
  result: DocViewResult | null
  isError: boolean
  errorMessage?: string
} {
  if (!toolResult) return { result: null, isError: false }
  const content = toolResult.content as ToolBlockContent

  // Check for error
  if (content?.is_error) {
    const message = typeof content.message === 'string'
      ? content.message
      : typeof content.error === 'string'
        ? content.error
        : 'Unknown error'
    return { result: null, isError: true, errorMessage: message }
  }

  // Result is nested under content.result
  const possibleResult = (content as Record<string, unknown>)?.result ?? content
  const result = possibleResult as unknown as DocViewResult

  if (result?.type === 'document' || result?.type === 'folder') {
    return { result, isError: false }
  }

  return { result: null, isError: false }
}

/**
 * Type guard for document result.
 */
function isDocumentResult(result: DocViewResult): result is DocViewDocumentResult {
  return result.type === 'document'
}

/**
 * Type guard for folder result.
 */
function isFolderResult(result: DocViewResult): result is DocViewFolderResult {
  return result.type === 'folder'
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/**
 * Document content preview.
 */
function DocumentPreview({ result }: { result: DocViewDocumentResult }) {
  return (
    <div className="space-y-2">
      {/* Word count and truncation warning */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{result.word_count.toLocaleString()} words</span>
        {result.was_truncated && (
          <span className="flex items-center gap-1 text-warning-foreground">
            <AlertTriangle className="h-3 w-3" />
            Content truncated
          </span>
        )}
      </div>

      {/* Content preview */}
      <div
        className={cn(
          'max-h-48 overflow-y-auto',
          'rounded-md border bg-muted/30 p-3',
          'text-xs font-mono whitespace-pre-wrap',
          'text-foreground/80'
        )}
      >
        {result.content}
      </div>
    </div>
  )
}


// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const DocViewBlock = React.memo(function DocViewBlock({
  toolUse,
  toolResult,
}: DocViewBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const navigate = useNavigate()

  // Get tree data for document/folder resolution
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
  const input = getDocViewInput(toolUse)
  const { result, isError, errorMessage } = getDocViewResult(toolResult)
  const hasResult = !!toolResult

  // Determine if viewing a document or folder
  const isDocument = result && isDocumentResult(result)
  const isFolder = result && isFolderResult(result)

  // Resolve document from tree store (for correct slug)
  const resolvedDocument = input?.path
    ? findDocumentByPath(input.path, documents, folders)
    : null

  // Resolve folder from tree store (for folder results)
  // Returns: Folder object, null (root), or undefined (not found)
  const resolvedFolder = result && isFolderResult(result)
    ? findFolderByPath(result.path, folders)
    : undefined

  // Get folder ID for FolderTreeView (null = root, string = folder ID)
  const rootFolderId = resolvedFolder === null
    ? null // Root folder
    : resolvedFolder?.id ?? null

  // Handle "View" navigation for header button
  const handleViewInEditor = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (!resolvedDocument || !projectSlug) return
    openDocument(resolvedDocument.id, resolvedDocument.slug, projectSlug, navigate)
  }, [resolvedDocument, projectSlug, navigate])

  // Handle document click in folder tree - navigate to editor
  const handleDocumentClick = useCallback((doc: Document) => {
    if (!projectSlug) return
    openDocument(doc.id, doc.slug, projectSlug, navigate)
  }, [projectSlug, navigate])

  // Parse path for display
  const parsedPath = input ? parseDocEditPath(input.path) : null

  // Icon based on result type
  const Icon = isFolder ? FolderOpen : FileText

  // Check if document no longer exists (for document results)
  const documentNoLongerExists = isDocument && !resolvedDocument

  // Status styling
  let statusLabel: string
  let statusClass: string
  if (isError) {
    statusLabel = 'Error'
    statusClass = 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700'
  } else if (hasResult) {
    statusLabel = 'Read'
    statusClass = 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700'
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
            <Icon className="h-3 w-3 shrink-0 text-muted-foreground/70" />

            {/* Path */}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-sm font-medium text-foreground/90 truncate">
                View:{' '}
                <span className="text-muted-foreground font-normal">
                  {parsedPath?.displayName || input?.path || 'Unknown'}
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

            {/* View button - only show if document exists in tree */}
            {resolvedDocument && projectSlug && (
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 gap-0.5 text-xs shrink-0 -my-2"
                onClick={handleViewInEditor}
              >
                <ExternalLink className="size-3" />
                View
              </Button>
            )}
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

            {/* Document no longer exists note */}
            {documentNoLongerExists && (
              <div className="text-xs text-muted-foreground italic">
                (document no longer exists in project)
              </div>
            )}

            {/* Document preview */}
            {result && isDocumentResult(result) && (
              <DocumentPreview result={result} />
            )}

            {/* Folder tree view - expandable nested tree */}
            {result && isFolderResult(result) && (
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
                Loading...
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
})
