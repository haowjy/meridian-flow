/**
 * Inline Diff Preview for doc_edit Tool
 *
 * Renders visual diff based on command type:
 * - str_replace: Inline diff with deletions (strikethrough red) and insertions (green)
 * - insert: Green block showing new content with line number
 * - append: Green block showing new content
 * - create: Preview of new file content (scroll container handles large files)
 */

import React from 'react'
import DiffMatchPatch from 'diff-match-patch'
import { cn } from '@/lib/utils'
import type { DocEditInput } from './types'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Metadata for truncated streaming content (>64KB buffer limit).
 * Provides head/tail previews when full JSON parsing was skipped.
 */
interface TruncationMeta {
  isTruncated: boolean
  activeKey: string | null  // Which field was truncated (e.g., "file_text", "new_str")
  charCount: number | null
  previewHead: string | null
  previewTail: string | null
}

interface DocEditDiffPreviewProps {
  input: DocEditInput
  /** Whether the tool is still streaming (state === 'preparing') */
  isStreaming?: boolean
  /** Truncation metadata when content exceeds streaming buffer limit */
  truncationMeta?: TruncationMeta
}

// =============================================================================
// TRUNCATION PREVIEW HELPER
// =============================================================================

/**
 * Renders truncated content preview with head/tail and char count indicator.
 * Used when streaming buffer was exceeded (>64KB).
 */
function TruncatedPreview({ meta, isStreaming = false }: { meta: TruncationMeta; isStreaming?: boolean }) {
  if (!meta.previewHead && !meta.previewTail) {
    return (
      <div className="text-xs text-muted-foreground italic py-2">
        Content too large to preview ({meta.charCount?.toLocaleString() ?? '?'} chars)
        {isStreaming && <span className="animate-pulse ml-1">▊</span>}
      </div>
    )
  }

  return (
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
      {meta.previewHead}
      {meta.previewTail && meta.previewTail !== meta.previewHead && (
        <>
          <span className="block my-1.5 text-center text-muted-foreground/70 text-[10px] select-none">
            ┈┈┈ {meta.charCount?.toLocaleString() ?? '?'} chars ┈┈┈
          </span>
          {meta.previewTail}
        </>
      )}
      {isStreaming && <span className="animate-pulse ml-1">▊</span>}
    </pre>
  )
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
  truncationMeta,
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
          truncationMeta={truncationMeta}
        />
      )

    case 'insert':
      return <InsertPreview newStr={new_str || ''} line={insert_line} isStreaming={isStreaming} truncationMeta={truncationMeta} />

    case 'append':
      return <AppendPreview newStr={new_str || ''} isStreaming={isStreaming} truncationMeta={truncationMeta} />

    case 'create':
      return <CreatePreview fileText={file_text || ''} isStreaming={isStreaming} truncationMeta={truncationMeta} />

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
  truncationMeta,
}: {
  oldStr: string
  newStr: string
  isStreaming?: boolean
  truncationMeta?: TruncationMeta
}) {
  // Don't render empty diff box (no content yet during streaming)
  const hasContent = oldStr !== '' || newStr !== ''

  // Show truncation preview if strings were truncated (no content parsed)
  // Show during streaming too so user sees head/tail preview with cursor
  const isTruncated = truncationMeta?.isTruncated && !hasContent
  if (isTruncated) {
    return (
      <div className="space-y-1.5">
        <TruncatedPreview meta={truncationMeta} isStreaming={isStreaming} />
      </div>
    )
  }

  if (!hasContent && !isStreaming) return null

  // Compute diff between old and new
  const diffs = dmp.diff_main(oldStr, newStr)
  dmp.diff_cleanupSemantic(diffs)

  // If streaming with no content yet, show just the cursor
  if (!hasContent && isStreaming) {
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
          <span className="animate-pulse">▊</span>
        </pre>
      </div>
    )
  }

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
  truncationMeta,
}: {
  newStr: string
  line?: number
  isStreaming?: boolean
  truncationMeta?: TruncationMeta
}) {
  const lineLabel = line !== undefined ? `at line ${line}` : 'at position'
  const hasContent = newStr !== ''
  // Show truncation preview during streaming too
  const isTruncated = truncationMeta?.isTruncated && !hasContent

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-success font-medium">
          + Insert
        </span>
        <span className="text-muted-foreground">
          {lineLabel}
          {(hasContent || isTruncated) && (
            <span className="ml-1">
              ({(hasContent ? newStr.length : truncationMeta?.charCount)?.toLocaleString() ?? '?'} chars)
            </span>
          )}
        </span>
      </div>
      {/* Truncated: show head/tail preview */}
      {isTruncated && <TruncatedPreview meta={truncationMeta} isStreaming={isStreaming} />}
      {/* Normal: show full content or streaming cursor */}
      {(hasContent || isStreaming) && !isTruncated && (
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
      )}
    </div>
  )
}

/**
 * Preview for append command.
 * Shows green block indicating content added to end.
 */
function AppendPreview({
  newStr,
  isStreaming = false,
  truncationMeta,
}: {
  newStr: string
  isStreaming?: boolean
  truncationMeta?: TruncationMeta
}) {
  const hasContent = newStr !== ''
  // Show truncation preview during streaming too
  const isTruncated = truncationMeta?.isTruncated && !hasContent

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-success font-medium">
          + Append
        </span>
        <span className="text-muted-foreground">
          to end of document
          {(hasContent || isTruncated) && (
            <span className="ml-1">
              ({(hasContent ? newStr.length : truncationMeta?.charCount)?.toLocaleString() ?? '?'} chars)
            </span>
          )}
        </span>
      </div>
      {/* Truncated: show head/tail preview */}
      {isTruncated && <TruncatedPreview meta={truncationMeta} isStreaming={isStreaming} />}
      {/* Normal: show full content or streaming cursor */}
      {(hasContent || isStreaming) && !isTruncated && (
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
      )}
    </div>
  )
}

/**
 * Preview for create command.
 * Shows full content - scroll container handles large files.
 */
function CreatePreview({
  fileText,
  isStreaming = false,
  truncationMeta,
}: {
  fileText: string
  isStreaming?: boolean
  truncationMeta?: TruncationMeta
}) {
  // Guard against undefined during streaming (fileText ?? '' in parent may not have resolved yet)
  const hasContent = fileText !== undefined && fileText !== ''
  // Show truncation preview during streaming too
  const isTruncated = truncationMeta?.isTruncated && !hasContent

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-success font-medium">
          + Create
        </span>
        <span className="text-muted-foreground">
          new file
          {(hasContent || isTruncated) && (
            <span className="ml-1">
              ({(hasContent ? fileText.length : truncationMeta?.charCount)?.toLocaleString() ?? '?'} chars)
            </span>
          )}
        </span>
      </div>
      {/* Truncated: show head/tail preview */}
      {isTruncated && <TruncatedPreview meta={truncationMeta} isStreaming={isStreaming} />}
      {/* Normal: show full content or streaming cursor */}
      {(hasContent || isStreaming) && !isTruncated && (
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
          {fileText}
          {isStreaming && <span className="animate-pulse ml-1">▊</span>}
        </pre>
      )}
    </div>
  )
}
