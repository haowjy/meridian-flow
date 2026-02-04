/**
 * TextEditorBlock - Visual representation of str_replace_based_edit_tool interactions
 *
 * Unified component that handles both view and edit operations:
 * - view: Document content preview or folder listing
 * - str_replace/insert/create: Edit operations with diff preview
 *
 * Uses the tool registry pattern for extensibility.
 */

import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import { FileEdit, FileText, FolderOpen, ExternalLink, AlertCircle, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TurnBlock, ToolBlockContent } from '@/features/threads/types'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { DocEditDiffPreview } from '../DocEditBlock/DocEditDiffPreview'
import {
  parseDocEditPath,
  findDocumentByPath,
  findFolderByPath,
} from '@/features/threads/utils/docPathResolver'
import { openDocument } from '@/core/lib/panelHelpers'
import type {
  TextEditorInput,
  TextEditorCommand,
  TextEditorDocumentResult,
  TextEditorFolderResult,
} from '@/features/threads/types/textEditor'
import {
  COMMAND_LABELS,
  isViewCommand,
  isDocumentResult,
  isFolderResult,
} from '@/features/threads/types/textEditor'
import {
  FolderTreeView,
  CollapsibleToolBlock,
  ToolStatusBadge,
  useToolStreamingState,
  type ToolStatus,
} from '../shared'
import { ToolStreamState } from '@/features/threads/stores/useToolStreamStore'
import type { Document } from '@/features/documents/types/document'

// =============================================================================
// TYPES
// =============================================================================

interface TextEditorBlockProps {
  toolUse: TurnBlock | null
  toolResult: TurnBlock | null
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract result status from tool_result block.
 */
function getResultStatus(toolResult: TurnBlock | null): {
  isError: boolean
  message?: string
} {
  if (!toolResult) return { isError: false }
  const content = toolResult.content as ToolBlockContent

  const isError = !!content?.isError

  let message: string | undefined
  if (typeof content?.message === 'string') {
    message = content.message
  } else if (typeof content?.error === 'string') {
    message = content.error
  }

  return { isError, message }
}

/**
 * Extract view result from tool_result block.
 */
function getViewResult(toolResult: TurnBlock | null): TextEditorDocumentResult | TextEditorFolderResult | null {
  if (!toolResult) return null
  const content = toolResult.content as ToolBlockContent

  if (content?.isError) return null

  // Result may be nested under content.result or flat
  const possibleResult = (content as Record<string, unknown>)?.result ?? content

  if (isDocumentResult(possibleResult)) {
    return possibleResult
  }
  if (isFolderResult(possibleResult)) {
    return possibleResult
  }

  return null
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

/**
 * Document content preview with line numbers.
 */
function DocumentPreview({ result }: { result: TextEditorDocumentResult }) {
  // Strip backend's embedded truncation message from display (legacy cleanup)
  const TRUNCATION_MARKER = '\n\n[Content truncated - too large to display fully]'
  const displayContent = result.was_truncated
    ? result.content.replace(TRUNCATION_MARKER, '')
    : result.content

  return (
    <div className="space-y-2">
      {/* Metadata row */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
        {result.word_count !== undefined && result.word_count > 0 && (
          <span>{result.word_count.toLocaleString()} words</span>
        )}
        {result.total_lines !== undefined && (
          <span>{result.total_lines} lines</span>
        )}
        {result.view_range && (
          <span className="px-1.5 py-0.5 rounded bg-muted/50">
            Lines {result.view_range[0]}-{result.view_range[1]}
          </span>
        )}
        {result.was_truncated && (
          <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-warning/15 text-warning">
            <AlertTriangle className="h-3 w-3" />
            Content truncated
          </span>
        )}
      </div>

      {/* Content preview (already has line numbers from backend) */}
      <div
        className={cn(
          'max-h-48 overflow-y-auto',
          'rounded-md border bg-muted/30 p-3',
          'text-xs font-mono whitespace-pre-wrap',
          'text-foreground/80'
        )}
      >
        {displayContent}
      </div>
    </div>
  )
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const TextEditorBlock = React.memo(function TextEditorBlock({
  toolUse,
  toolResult,
}: TextEditorBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const navigate = useNavigate()

  // Get tree data for document/folder resolution
  const { documents, folders } = useTreeStore(
    useShallow((s) => ({
      documents: s.documents,
      folders: s.folders,
    }))
  )

  // Get streaming state for progressive field display via dedicated hook
  const {
    input: streamingInput,
    isGenerating: toolIsGenerating,
    state: toolState,
    argsJsonTruncated,
    activeArgKey,
    activeArgChars,
    activeArgPreviewHead,
    activeArgPreviewTail,
  } = useToolStreamingState({
    blockContent: toolUse?.content as ToolBlockContent | undefined,
  })

  // Get project slug from URL for navigation
  const location = useLocation()
  const projectSlug = location.pathname.match(/^\/projects\/([^/]+)/)?.[1] || null

  // Parse input - prefer streaming input state over block content (progressive display)
  const content = toolUse?.content as ToolBlockContent | undefined
  const fallbackInput = content?.input as TextEditorInput | undefined

  // Read from streaming input (AG-UI) instead of legacy fields
  const path = (streamingInput?.path as string | undefined) ?? fallbackInput?.path
  const command = (streamingInput?.command as TextEditorCommand | undefined) ?? fallbackInput?.command
  const viewRange = (streamingInput?.view_range as [number, number] | undefined) ?? fallbackInput?.view_range
  const oldStr = (streamingInput?.old_str as string | undefined) ?? fallbackInput?.old_str
  const newStr = (streamingInput?.new_str as string | undefined) ?? fallbackInput?.new_str
  const fileText = (streamingInput?.file_text as string | undefined) ?? fallbackInput?.file_text
  const insertLine = (streamingInput?.insert_line as number | undefined) ?? fallbackInput?.insert_line

  // Use the hook's isGenerating flag to determine if args are still streaming
  const isStreaming = toolIsGenerating

  // Construct input object from extracted fields
  const input: TextEditorInput | null =
    command && path
      ? { command, path, view_range: viewRange, old_str: oldStr, new_str: newStr, file_text: fileText, insert_line: insertLine }
      : null

  const { isError, message } = getResultStatus(toolResult)
  const hasResult = !!toolResult

  // Get view result if this is a view command
  const viewResult = input && isViewCommand(input.command) ? getViewResult(toolResult) : null
  const isDocResult = viewResult && isDocumentResult(viewResult)
  const isFolderRes = viewResult && isFolderResult(viewResult)

  // Hydrate tree store when folder result arrives
  useEffect(() => {
    if (viewResult && isFolderResult(viewResult) && !isError) {
      const currentFolders = useTreeStore.getState().folders
      const parentFolder = findFolderByPath(viewResult.path, currentFolders)
      const parentFolderId = parentFolder === null ? null : parentFolder?.id ?? null

      useTreeStore.getState().hydrateFromFolderView(
        parentFolderId,
        viewResult.folders,
        viewResult.documents
      )
    }
  }, [viewResult, isError])

  // Find document in tree for navigation
  const resolvedDocument = input?.path
    ? findDocumentByPath(input.path, documents, folders)
    : null

  // Resolve folder for folder results
  const resolvedFolder = isFolderRes
    ? findFolderByPath(viewResult.path, folders)
    : undefined

  const rootFolderId = resolvedFolder === null
    ? null
    : resolvedFolder?.id ?? null

  // Handle "View" navigation
  const handleViewInEditor = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!projectSlug) return

    if (resolvedDocument) {
      openDocument(resolvedDocument.id, resolvedDocument.path, projectSlug, navigate)
      return
    }

    // Fallback for documents not in tree
    if (input?.path) {
      const pathSegment = input.path.replace(/^\//, '')
      navigate({
        to: '/projects/$slug/documents/$',
        params: { slug: projectSlug, _splat: encodeURIComponent(pathSegment).split('%2F').join('/') },
      })
    }
  }

  const handleDocumentClick = (doc: Document) => {
    if (!projectSlug) return
    openDocument(doc.id, doc.path, projectSlug, navigate)
  }

  // Parse path for display
  const parsedPath = input ? parseDocEditPath(input.path) : null

  // Command label and icon for header
  const commandLabel = input
    ? COMMAND_LABELS[input.command] || input.command
    : 'Edit'

  // Icon based on command type
  const Icon = input && isViewCommand(input.command)
    ? (isFolderRes ? FolderOpen : FileText)
    : FileEdit

  // Check if document no longer exists (for document results)
  // If viewResult has an ID but resolvedDocument is null, document was deleted
  const documentNoLongerExists = isDocResult && viewResult.id && !resolvedDocument

  // Determine status for badge
  let status: ToolStatus
  let statusLabel: string
  if (isError) {
    status = 'error'
    statusLabel = 'Error'
  } else if (hasResult) {
    status = 'success'
    statusLabel = input && isViewCommand(input.command) ? 'Read' : 'Applied'
  } else {
    status = 'pending'
    statusLabel = 'Pending...'
  }

  return (
    <CollapsibleToolBlock
      icon={Icon}
      label={
        <>
          <span className="text-sm font-medium text-foreground/90 shrink-0">
            {commandLabel}
          </span>
          <span className="text-sm font-normal text-muted-foreground truncate min-w-0 @[200px]:inline hidden">
            {parsedPath?.displayName || input?.path || ''}
          </span>
        </>
      }
      statusBadge={<ToolStatusBadge status={status} label={statusLabel} />}
      actions={
        input?.path && projectSlug ? (
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
      isGenerating={!hasResult && !isError && (toolState === null || toolIsGenerating)}
      isExecuting={!hasResult && !isError && toolState === ToolStreamState.EXECUTING}
    >
      {/* Error message */}
      {isError && message && (
        <div
          className={cn(
            'flex items-start gap-2',
            'text-xs p-2.5 rounded-md',
            'bg-error/15 text-error'
          )}
        >
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="leading-relaxed">{message}</span>
        </div>
      )}

      {/* Document no longer exists note */}
      {documentNoLongerExists && (
        <div className="text-xs text-muted-foreground italic">
          (document no longer exists in project)
        </div>
      )}

      {/* View command: Document preview */}
      {input && isViewCommand(input.command) && isDocResult && (
        <DocumentPreview result={viewResult} />
      )}

      {/* View command: Folder tree view */}
      {input && isViewCommand(input.command) && isFolderRes && (
        <FolderTreeView
          rootFolderId={rootFolderId}
          folders={folders}
          documents={documents}
          onDocumentClick={handleDocumentClick}
          showWordCount={true}
        />
      )}

      {/* Edit commands: Diff preview */}
      {input && !isViewCommand(input.command) && !isError && (
        <DocEditDiffPreview
          input={{
            command: input.command as 'str_replace' | 'insert' | 'append' | 'create',
            path: input.path,
            old_str: input.old_str,
            new_str: input.new_str,
            insert_line: input.insert_line,
            file_text: input.file_text,
          }}
          isStreaming={isStreaming}
          truncationMeta={argsJsonTruncated ? {
            isTruncated: true,
            activeKey: activeArgKey,
            charCount: activeArgChars,
            previewHead: activeArgPreviewHead,
            previewTail: activeArgPreviewTail,
          } : undefined}
        />
      )}

      {/* Pending state - only show before streaming starts */}
      {!hasResult && !isError && toolState === null && input && isViewCommand(input.command) && (
        <div className="text-xs text-muted-foreground italic py-2">
          Loading...
        </div>
      )}
    </CollapsibleToolBlock>
  )
})
