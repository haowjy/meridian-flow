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
}: DocEditDiffPreviewProps) {
  const { command, old_str, new_str, file_text, insert_line } = input

  switch (command) {
    case 'str_replace':
      return <StrReplaceDiff oldStr={old_str || ''} newStr={new_str || ''} />

    case 'insert':
      return <InsertPreview newStr={new_str || ''} line={insert_line} />

    case 'append':
      return <AppendPreview newStr={new_str || ''} />

    case 'create':
      return <CreatePreview fileText={file_text || ''} />

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
}: {
  oldStr: string
  newStr: string
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
                'bg-red-500/20 text-red-700 dark:text-red-400 line-through decoration-red-500/60',
              // Insertion: green background
              op === 1 && 'bg-green-500/20 text-green-700 dark:text-green-400',
              // Equal: no styling
              op === 0 && 'text-foreground/80'
            )}
          >
            {text}
          </span>
        ))}
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
}: {
  newStr: string
  line?: number
}) {
  const lineLabel = line !== undefined ? `at line ${line}` : 'at position'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-green-600 dark:text-green-400 font-medium">
          + Insert
        </span>
        <span className="text-muted-foreground">{lineLabel}</span>
      </div>
      <pre
        className={cn(
          'text-xs whitespace-pre-wrap font-mono',
          'bg-green-500/10 border-l-2 border-green-500/50',
          'rounded-md px-3 py-2',
          'overflow-auto max-h-48',
          'text-green-700 dark:text-green-400',
          'leading-relaxed'
        )}
      >
        {newStr}
      </pre>
    </div>
  )
}

/**
 * Preview for append command.
 * Shows green block indicating content added to end.
 */
function AppendPreview({ newStr }: { newStr: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-green-600 dark:text-green-400 font-medium">
          + Append
        </span>
        <span className="text-muted-foreground">to end of document</span>
      </div>
      <pre
        className={cn(
          'text-xs whitespace-pre-wrap font-mono',
          'bg-green-500/10 border-l-2 border-green-500/50',
          'rounded-md px-3 py-2',
          'overflow-auto max-h-48',
          'text-green-700 dark:text-green-400',
          'leading-relaxed'
        )}
      >
        {newStr}
      </pre>
    </div>
  )
}

/**
 * Preview for create command.
 * Shows truncated preview of new file content.
 */
function CreatePreview({ fileText }: { fileText: string }) {
  const maxLength = 500
  const truncated = fileText.length > maxLength
  const displayText = truncated
    ? fileText.slice(0, maxLength) + '\n...'
    : fileText

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-green-600 dark:text-green-400 font-medium">
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
          'bg-green-500/10 border-l-2 border-green-500/50',
          'rounded-md px-3 py-2',
          'overflow-auto max-h-48',
          'text-green-700 dark:text-green-400',
          'leading-relaxed'
        )}
      >
        {displayText}
      </pre>
    </div>
  )
}
