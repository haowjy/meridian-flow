import { useState, useRef, useEffect, KeyboardEvent, ChangeEvent } from 'react'
import { cn } from '@/lib/utils'

interface InlineNameEditorProps {
  initialValue: string
  existingNames: string[]
  onSubmit: (name: string) => void
  onCancel: () => void
  className?: string
}

/**
 * Inline text input for renaming documents/folders in the tree.
 * - Enter: Submit if valid (non-empty, no duplicates)
 * - Escape/blur: Cancel
 * - Shows inline error for duplicate names
 */
export function InlineNameEditor({
  initialValue,
  existingNames,
  onSubmit,
  onCancel,
  className,
}: InlineNameEditorProps) {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Auto-focus and select all text on mount
  // Use requestAnimationFrame to wait for next paint (avoids race with render/animations)
  useEffect(() => {
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus()
        inputRef.current.select()
      }
    })
  }, [])

  const validate = (name: string): string | null => {
    const trimmed = name.trim()
    if (!trimmed) {
      return 'Name cannot be empty'
    }
    // Check for duplicates (case-insensitive, excluding current name)
    const isDuplicate = existingNames.some(
      (existing) =>
        existing.toLowerCase() === trimmed.toLowerCase() &&
        existing.toLowerCase() !== initialValue.toLowerCase()
    )
    if (isDuplicate) {
      return 'A file or folder with this name already exists'
    }
    return null
  }

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setValue(newValue)
    // Clear error on change, will re-validate on submit
    if (error) {
      setError(null)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = value.trim()
      const validationError = validate(trimmed)
      if (validationError) {
        setError(validationError)
        return
      }
      onSubmit(trimmed)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const handleBlur = () => {
    // Cancel on blur (user clicked away)
    onCancel()
  }

  return (
    <div className="flex-1 min-w-0">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        className={cn(
          // Match tree item typography
          'w-full text-xs md:text-sm',
          // Minimal styling to blend with tree
          'bg-background border border-input rounded-sm px-1.5 py-0.5',
          'outline-none focus:ring-1 focus:ring-ring',
          error && 'border-destructive focus:ring-destructive',
          className
        )}
        aria-invalid={!!error}
        aria-describedby={error ? 'inline-name-error' : undefined}
      />
      {error && (
        <p
          id="inline-name-error"
          className="text-xs text-destructive mt-0.5 truncate"
        >
          {error}
        </p>
      )}
    </div>
  )
}
