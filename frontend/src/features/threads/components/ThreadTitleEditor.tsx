import { useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'

interface ThreadTitleEditorProps {
  initialValue: string
  onSubmit: (title: string) => void
  onCancel: () => void
  className?: string
}

/**
 * Inline input for editing thread titles.
 *
 * Single Responsibility: Handles text input with keyboard shortcuts.
 * - Enter: Submit if valid (non-empty, different from initial)
 * - Escape: Cancel
 * - Blur: Submit if valid, cancel otherwise
 *
 * Used by: ThreadListItem (sidebar), ThreadHeader (center panel)
 */
export function ThreadTitleEditor({
  initialValue,
  onSubmit,
  onCancel,
  className,
}: ThreadTitleEditorProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus and select all text on mount
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [])

  const handleSubmit = () => {
    const trimmed = inputRef.current?.value.trim() || ''
    if (trimmed && trimmed !== initialValue) {
      onSubmit(trimmed)
    } else {
      onCancel()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <input
      ref={inputRef}
      type="text"
      defaultValue={initialValue}
      onKeyDown={handleKeyDown}
      onBlur={handleSubmit}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'w-full bg-transparent outline-none',
        'border-b border-primary focus:border-primary',
        'font-medium',
        className
      )}
    />
  )
}
