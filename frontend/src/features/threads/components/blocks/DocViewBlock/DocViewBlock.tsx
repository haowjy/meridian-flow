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

import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import { FileText, FolderOpen, ExternalLink, AlertCircle, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TurnBlock, ToolBlockContent } from '@/features/threads/types'
import { useTreeStore } from '@/core/stores/useTreeStore'
import {
  parseDocEditPath,
  findDocumentByPath,
  findFolderByPath,
} from '@/features/threads/utils/docPathResolver'
import { openDocument } from '@/core/lib/panelHelpers'
import {
  FolderTreeView,
  CollapsibleToolBlock,
  ToolStatusBadge,
  useToolStreamingState,
  type ToolStatus,
} from '../shared'
import { ToolStreamState } from '@/features/threads/stores/useToolStreamStore'
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

  // Get streaming state for animation control via dedicated hook
  const { isGenerating: toolIsGenerating, state: toolState } = useToolStreamingState({
    blockContent: toolUse?.content as ToolBlockContent | undefined,
  })

  // Parse input and result
  const input = getDocViewInput(toolUse)
  const { result, isError, errorMessage } = getDocViewResult(toolResult)
  const hasResult = !!toolResult

  // Determine if viewing a document or folder
  const isDocument = result && isDocumentResult(result)
  const isFolder = result && isFolderResult(result)

  // Hydrate tree store when folder result arrives (so FolderTreeView can render)
  // NOTE: Use getState().folders instead of reactive `folders` to avoid infinite loop.
  // This effect UPDATES folders, so it must READ via getState(), not subscribe.
  useEffect(() => {
    if (result && isFolderResult(result) && !isError) {
      // Resolve parent folder ID from path (read from store without subscribing)
      const currentFolders = useTreeStore.getState().folders
      const parentFolder = findFolderByPath(result.path, currentFolders)
      const parentFolderId = parentFolder === null ? null : parentFolder?.id ?? null

      useTreeStore.getState().hydrateFromFolderView(
        parentFolderId,
        result.folders,
        result.documents
      )
    }
  }, [result, isError])

  // Resolve document from tree store (for correct slug)
  const resolvedDocument = input?.path
    ? findDocumentByPath(input.path, documents, folders)
    : null

  // For document results, use result data directly (works even if tree store empty)
  // Fall back to tree store resolution for non-document results or when result not available
  const docId = (result && isDocumentResult(result))
    ? result.id
    : resolvedDocument?.id ?? null

  // Derive slug from result.path for document results
  // Path format: "/folder/document-name.md" → slug is the path without leading slash
  const docSlug = (result && isDocumentResult(result))
    ? result.path.replace(/^\//, '')
    : resolvedDocument?.slug ?? null

  // Resolve folder from tree store (for folder results)
  // Returns: Folder object, null (root), or undefined (not found)
  const resolvedFolder = result && isFolderResult(result)
    ? findFolderByPath(result.path, folders)
    : undefined

  // Get folder ID for FolderTreeView (null = root, string = folder ID)
  const rootFolderId = resolvedFolder === null
    ? null // Root folder
    : resolvedFolder?.id ?? null

  // Event handlers: React Compiler handles memoization (no manual useCallback needed)
  const handleViewInEditor = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!docId || !docSlug || !projectSlug) return
    openDocument(docId, docSlug, projectSlug, navigate)
  }

  const handleDocumentClick = (doc: Document) => {
    if (!projectSlug) return
    openDocument(doc.id, doc.slug, projectSlug, navigate)
  }

  // Parse path for display
  const parsedPath = input ? parseDocEditPath(input.path) : null

  // Icon based on result type
  const Icon = isFolder ? FolderOpen : FileText

  // Check if document no longer exists (for document results)
  // Use docId which comes from result.id when available
  const documentNoLongerExists = isDocument && !docId

  // Determine status for badge
  let status: ToolStatus
  let statusLabel: string
  if (isError) {
    status = 'error'
    statusLabel = 'Error'
  } else if (hasResult) {
    status = 'success'
    statusLabel = 'Read'
  } else {
    status = 'pending'
    statusLabel = 'Pending...'
  }

  return (
    <CollapsibleToolBlock
      icon={Icon}
      label={
        <>
          <span className="text-sm font-medium text-foreground/90 shrink-0">View</span>
          <span className="text-sm font-normal text-muted-foreground truncate min-w-0 @[200px]:inline hidden">
            {parsedPath?.displayName || input?.path || ''}
          </span>
        </>
      }
      statusBadge={<ToolStatusBadge status={status} label={statusLabel} />}
      actions={
        docId && docSlug && projectSlug ? (
          <button
            type="button"
            className="flex items-center justify-center gap-1 w-full h-full text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={handleViewInEditor}
          >
            <ExternalLink className="size-3" />
            View
          </button>
        ) : undefined
      }
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      // Animation: shimmer during PREPARING (args streaming) or when pending (no state yet)
      // Stops when tool args are complete (state becomes 'ready') or result arrives
      isGenerating={!hasResult && !isError && (toolState === null || toolIsGenerating)}
      // Pulse animation during EXECUTING (tool running server-side)
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

      {/* Pending state - only show before streaming starts */}
      {!hasResult && !isError && toolState === null && (
        <div className="text-xs text-muted-foreground italic py-2">
          Loading...
        </div>
      )}
    </CollapsibleToolBlock>
  )
})
