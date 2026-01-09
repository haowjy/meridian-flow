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
import type { TurnBlock, ToolBlockContent } from '@/features/chats/types'
import { useTreeStore } from '@/core/stores/useTreeStore'
import { Button } from '@/shared/components/ui/button'
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/shared/components/ui/collapsible'
import { DocEditDiffPreview } from './DocEditDiffPreview'
import {
  parseDocEditPath,
  findDocumentByPath,
} from '@/features/chats/utils/docPathResolver'
import { openDocument } from '@/core/lib/panelHelpers'
import type { DocEditInput } from './types'
import { COMMAND_LABELS } from './types'

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
 * Extract DocEditInput from tool_use block.
 */
function getDocEditInput(toolUse: TurnBlock | null): DocEditInput | null {
  if (!toolUse) return null
  const content = toolUse.content as ToolBlockContent
  const input = content?.input as DocEditInput | undefined
  if (!input || !input.command || !input.path) return null
  return input
}

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

  // Get project slug from URL for navigation
  const location = useLocation()
  const projectSlug = location.pathname.match(/^\/projects\/([^/]+)/)?.[1] || null

  // Parse input and resolve document
  const input = getDocEditInput(toolUse)
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

  // Status styling - use dark text on light backgrounds for good contrast
  let statusLabel: string
  let statusClass: string
  if (isError) {
    statusLabel = 'Error'
    statusClass = 'bg-red-100 text-red-800 border-red-300 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700'
  } else if (hasResult) {
    statusLabel = 'Applied'
    statusClass = 'bg-green-100 text-green-800 border-green-300 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700'
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
            <FileEdit className="h-3 w-3 shrink-0 text-muted-foreground/70" />

            {/* Command and path */}
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="text-sm font-medium text-foreground/90 truncate">
                {commandLabel}:{' '}
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

            {/* View button - show if we have path and project context */}
            {input?.path && projectSlug && (
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

        {/* Expanded content - diff preview */}
        <CollapsibleContent>
          <div className="border-t px-3 py-3 space-y-2">
            {/* Error message */}
            {isError && message && (
              <div
                className={cn(
                  'flex items-start gap-2',
                  'text-xs p-2.5 rounded-md',
                  'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                )}
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">{message}</span>
              </div>
            )}

            {/* Document not found warning (except for create command) */}
            {!resolvedDocument && input?.command !== 'create' && (
              <div
                className={cn(
                  'flex items-start gap-2',
                  'text-xs p-2.5 rounded-md',
                  'bg-warning/10 text-warning-foreground'
                )}
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span className="leading-relaxed">
                  Document not found in project tree
                </span>
              </div>
            )}

            {/* Diff preview */}
            {input && <DocEditDiffPreview input={input} />}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
})
