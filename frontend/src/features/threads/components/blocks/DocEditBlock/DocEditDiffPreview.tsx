/**
 * Inline Diff Preview for doc_edit Tool
 *
 * Renders visual diff based on command type:
 * - str_replace: Inline diff with deletions (strikethrough red) and insertions (green)
 * - insert: Green block showing new content with line number
 * - append: Green block showing new content
 * - create: Preview of new file content (truncated for large files)
 */

import React from 'react'
import DiffMatchPatch from 'diff-match-patch'
import { cn } from '@/lib/utils'
import type { DocEditInput } from './types'

// =============================================================================
// TYPES
// =============================================================================

interface DocEditDiffPreviewProps {
  input: DocEditInput
  /** Whether the tool is still streaming (state === 'preparing') */
  isStreaming?: boolean
}

// =============================================================================
// DIFF ENGINE
// =============================================================================

const dmp = new DiffMatchPatch()

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export const DocEditDiffPreview = React.memo(function DocEditDiffPreview({
  input,
  isStreaming = false,
}: DocEditDiffPreviewProps) {
  const { command, old_str, new_str, file_text } = input
  const insert_line = input.insert_line // Keep separate to avoid destructuring unused var warning

  switch (command) {
    case 'str_replace':
      return (
        <StrReplaceDiff
          oldStr={old_str || ''}
          newStr={new_str || ''}
          isStreaming={isStreaming}
        />
      )

    case 'insert':
      return <InsertPreview newStr={new_str || ''} line={insert_line} isStreaming={isStreaming} />

    case 'append':
      return <AppendPreview newStr={new_str || ''} isStreaming={isStreaming} />

    case 'create':
      return <CreatePreview fileText={file_text || ''} isStreaming={isStreaming} />

    default:
      return (
        <div className="text-xs text-muted-foreground italic">
          Unknown command: {command as string}
        </div>
      )
  }
})

// =============================================================================
// COMMAND-SPECIFIC RENDERERS
// =============================================================================

/**
 * Inline diff for str_replace command.
 * Shows old text with strikethrough and new text highlighted.
 */
function StrReplaceDiff({
  oldStr,
  newStr,
  isStreaming = false,
}: {
  oldStr: string
  newStr: string
  isStreaming?: boolean
}) {
  // Compute diff between old and new
  const diffs = dmp.diff_main(oldStr, newStr)
  dmp.diff_cleanupSemantic(diffs)

  return (
    <div className="space-y-1.5">
      <pre
        className={cn(
          'text-xs whitespace-pre-wrap font-mono',
          'bg-muted/50 rounded-md px-3 py-2',
          'overflow-auto max-h-48',
          'leading-relaxed'
        )}
      >
        {diffs.map(([op, text], i) => (
          <span
            key={i}
            className={cn(
              // Deletion: red background with strikethrough
              op === -1 &&
                'bg-error/20 text-error line-through decoration-error/60',
              // Insertion: green background
              op === 1 && 'bg-success/20 text-success',
              // Equal: no styling
              op === 0 && 'text-foreground/80'
            )}
          >
            {text}
          </span>
        ))}
        {isStreaming && (
          <span className="animate-pulse ml-1">▊</span>
        )}
      </pre>
    </div>
  )
}

/**
 * Preview for insert command.
 * Shows green block with line number indicator.
 */
function InsertPreview({
  newStr,
  line,
  isStreaming = false,
}: {
  newStr: string
  line?: number
  isStreaming?: boolean
}) {
  const lineLabel = line !== undefined ? `at line ${line}` : 'at position'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-success font-medium">
          + Insert
        </span>
        <span className="text-muted-foreground">{lineLabel}</span>
      </div>
      <pre
        className={cn(
          'text-xs whitespace-pre-wrap font-mono',
          'bg-success/10 border-l-2 border-success/50',
          'rounded-md px-3 py-2',
          'overflow-auto max-h-48',
          'text-success',
          'leading-relaxed'
        )}
      >
        {newStr}
        {isStreaming && <span className="animate-pulse ml-1">▊</span>}
      </pre>
    </div>
  )
}

/**
 * Preview for append command.
 * Shows green block indicating content added to end.
 */
function AppendPreview({ newStr, isStreaming = false }: { newStr: string; isStreaming?: boolean }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-success font-medium">
          + Append
        </span>
        <span className="text-muted-foreground">to end of document</span>
      </div>
      <pre
        className={cn(
          'text-xs whitespace-pre-wrap font-mono',
          'bg-success/10 border-l-2 border-success/50',
          'rounded-md px-3 py-2',
          'overflow-auto max-h-48',
          'text-success',
          'leading-relaxed'
        )}
      >
        {newStr}
        {isStreaming && <span className="animate-pulse ml-1">▊</span>}
      </pre>
    </div>
  )
}

/**
 * Preview for create command.
 * Shows truncated preview of new file content.
 */
function CreatePreview({ fileText, isStreaming = false }: { fileText: string; isStreaming?: boolean }) {
  const maxLength = 500
  const truncated = fileText.length > maxLength
  const displayText = truncated
    ? fileText.slice(0, maxLength) + '\n...'
    : fileText

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-success font-medium">
          + Create
        </span>
        <span className="text-muted-foreground">
          new file
          {truncated && (
            <span className="ml-1">({fileText.length.toLocaleString()} chars)</span>
          )}
        </span>
      </div>
      <pre
        className={cn(
          'text-xs whitespace-pre-wrap font-mono',
          'bg-success/10 border-l-2 border-success/50',
          'rounded-md px-3 py-2',
          'overflow-auto max-h-48',
          'text-success',
          'leading-relaxed'
        )}
      >
        {displayText}
        {isStreaming && <span className="animate-pulse ml-1">▊</span>}
      </pre>
    </div>
  )
}
