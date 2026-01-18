/**
 * DocEditBlock - Visual representation of doc_edit tool interactions
 *
 * Displays document edit operations with:
 * - Collapsible inline diff preview
 * - Status badge (Pending/Applied/Error)
 * - "View" button to navigate to document
 *
 * Uses the tool registry pattern for extensibility.
 */

import React, { useState } from 'react'
import { useNavigate, useLocation } from '@tanstack/react-router'
import { useShallow } from 'zustand/react/shallow'
import { FileEdit, ExternalLink, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TurnBlock, ToolBlockContent } from '@/features/threads/types'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { DocEditDiffPreview } from './DocEditDiffPreview'
import {
  parseDocEditPath,
  findDocumentByPath,
} from '@/features/threads/utils/docPathResolver'
import { openDocument } from '@/core/lib/panelHelpers'
import type { DocEditInput, DocEditCommand } from './types'
import { COMMAND_LABELS } from './types'
import {
  CollapsibleToolBlock,
  ToolStatusBadge,
  useToolStreamingState,
  type ToolStatus,
} from '../shared'
import { ToolStreamState } from '@/features/threads/stores/useToolStreamStore'

// =============================================================================
// TYPES
// =============================================================================

interface DocEditBlockProps {
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

  // Check for error in content
  const isError = !!content?.is_error

  // Try to extract message from result
  let message: string | undefined
  if (typeof content?.message === 'string') {
    message = content.message
  } else if (typeof content?.error === 'string') {
    message = content.error
  }

  return { isError, message }
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const DocEditBlock = React.memo(function DocEditBlock({
  toolUse,
  toolResult,
}: DocEditBlockProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const navigate = useNavigate()

  // Get tree data for document resolution
  const { documents, folders } = useTreeStore(
    useShallow((s) => ({
      documents: s.documents,
      folders: s.folders,
    }))
  )

  // Get streaming state for progressive field display via dedicated hook
  const { input: streamingInput, isGenerating: toolIsGenerating, state: toolState } = useToolStreamingState({
    blockContent: toolUse?.content as ToolBlockContent | undefined,
  })

  // Get project slug from URL for navigation
  const location = useLocation()
  const projectSlug = location.pathname.match(/^\/projects\/([^/]+)/)?.[1] || null

  // Parse input - prefer streaming input state over block content (progressive display)
  const content = toolUse?.content as ToolBlockContent | undefined
  const fallbackInput = content?.input as DocEditInput | undefined

  // Read from streaming input (AG-UI) instead of legacy fields
  const path = (streamingInput?.path as string | undefined)
    ?? fallbackInput?.path
  const command = (streamingInput?.command as DocEditCommand | undefined)
    ?? fallbackInput?.command
  const oldStr = (streamingInput?.old_str as string | undefined)
    ?? fallbackInput?.old_str
  const newStr = (streamingInput?.new_str as string | undefined)
    ?? fallbackInput?.new_str
  const fileText = (streamingInput?.file_text as string | undefined)
    ?? fallbackInput?.file_text
  const insertLine = (streamingInput?.insert_line as number | undefined)
    ?? fallbackInput?.insert_line

  // Use the hook's isGenerating flag to determine if args are still streaming
  const isStreaming = toolIsGenerating

  // Construct input object from extracted fields
  const input: DocEditInput | null =
    command && path
      ? { command, path, old_str: oldStr, new_str: newStr, file_text: fileText, insert_line: insertLine }
      : null
  const { isError, message } = getResultStatus(toolResult)
  const hasResult = !!toolResult

  // Find document in tree for "document not found" warning
  const resolvedDocument = input?.path
    ? findDocumentByPath(input.path, documents, folders)
    : null

  // Handle "View" navigation
  const handleViewInEditor = (e: React.MouseEvent) => {
    e.stopPropagation() // Prevent expanding/collapsing
    if (!projectSlug) return

    // Use openDocument() when we have resolved document (handles mobile swap)
    if (resolvedDocument) {
      openDocument(resolvedDocument.id, resolvedDocument.slug, projectSlug, navigate)
      return
    }

    // Fallback for documents not in tree (e.g., newly created)
    if (input?.path) {
      const docPath = input.path.replace(/^\//, '').replace(/\.md$/, '')
      navigate({
        to: '/projects/$slug/documents/$',
        params: { slug: projectSlug, _splat: docPath },
      })
    }
  }

  // Parse path for display
  const parsedPath = input ? parseDocEditPath(input.path) : null

  // Command label for header
  const commandLabel = input
    ? COMMAND_LABELS[input.command] || input.command
    : 'Edit'

  // Determine status for badge
  let status: ToolStatus
  let statusLabel: string
  if (isError) {
    status = 'error'
    statusLabel = 'Error'
  } else if (hasResult) {
    status = 'success'
    statusLabel = 'Applied'
  } else {
    status = 'pending'
    statusLabel = 'Pending...'
  }

  return (
    <CollapsibleToolBlock
      icon={FileEdit}
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
      // Animation: shimmer during PREPARING (args streaming) or when pending (no state yet)
      // Stops when tool args are complete (state becomes 'ready') or result arrives
      isGenerating={!hasResult && !isError && (toolState === null || toolIsGenerating)}
      // Pulse animation during EXECUTING (tool running server-side)
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

      {/* Diff preview */}
      {input && (
        <DocEditDiffPreview
          input={input}
          isStreaming={isStreaming}
        />
      )}
    </CollapsibleToolBlock>
  )
})
