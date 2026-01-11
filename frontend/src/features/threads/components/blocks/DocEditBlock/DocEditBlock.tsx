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
import { Button } from '@/shared/components/ui/button'
import { DocEditDiffPreview } from './DocEditDiffPreview'
import {
  parseDocEditPath,
  findDocumentByPath,
} from '@/features/threads/utils/docPathResolver'
import { openDocument } from '@/core/lib/panelHelpers'
import type { DocEditInput } from './types'
import { COMMAND_LABELS } from './types'
import {
  CollapsibleToolBlock,
  ToolStatusBadge,
  type ToolStatus,
} from '../shared'

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
        <span className="text-sm font-medium text-foreground/90 truncate">
          {commandLabel}:{' '}
          <span className="text-muted-foreground font-normal">
            {parsedPath?.displayName || input?.path || 'Unknown'}
          </span>
        </span>
      }
      statusBadge={<ToolStatusBadge status={status} label={statusLabel} />}
      actions={
        input?.path && projectSlug ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 gap-0.5 text-xs shrink-0"
            onClick={handleViewInEditor}
          >
            <ExternalLink className="size-3" />
            View
          </Button>
        ) : undefined
      }
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
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
    </CollapsibleToolBlock>
  )
})
