import { useState, useRef, useEffect, KeyboardEvent, ChangeEvent, MouseEvent } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface InlineNameEditorProps {
  initialValue: string
  existingNames: string[]
  onSubmit: (name: string) => void
  onCancel: () => void
  /**
   * Mode affects validation + blur behavior:
   * - 'rename' (default): used for existing items, enforces duplicate checks and
   *   submits on blur when valid.
   * - 'create': used for new, temporary items. Duplicate checks are skipped
   *   (uniqueness handled by caller) and blur only submits if the user actually
   *   changed the name from its initial value. Otherwise blur cancels.
   */
  mode?: 'rename' | 'create'
  className?: string
}

/**
 * Inline text input for renaming documents/folders in the tree.
 * - Enter: Submit if valid (non-empty, no duplicates)
 * - Escape: Cancel
 * - Blur (click away): Submit if valid, cancel if empty
 * - Shows inline error for duplicate names
 */
export function InlineNameEditor({
  initialValue,
  existingNames,
  onSubmit,
  onCancel,
  mode = 'rename',
  className,
}: InlineNameEditorProps) {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  // Tracks whether the user has actually changed the text.
  // This lets us distinguish between initial focus/blur races (e.g. after
  // selecting a context menu item) and intentional edits.
  const [hasUserEdited, setHasUserEdited] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const mountTimeRef = useRef<number | null>(null)

  // Auto-focus and select all text on mount
  // Use requestAnimationFrame to wait for next paint (avoids race with render/animations)
  useEffect(() => {
    mountTimeRef.current = performance.now()

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
    // For rename, enforce duplicate checks. For create, allow duplicates and let
    // the caller generate unique names (e.g., "Untitled (2)").
    if (mode === 'rename') {
      // Check for duplicates (case-insensitive, excluding current name)
      const isDuplicate = existingNames.some(
        (existing) =>
          existing.toLowerCase() === trimmed.toLowerCase() &&
          existing.toLowerCase() !== initialValue.toLowerCase()
      )
      if (isDuplicate) {
        return 'A file or folder with this name already exists'
      }
    }
    return null
  }

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value
    setValue(newValue)
    if (!hasUserEdited) {
      setHasUserEdited(true)
    }
    // Clear error on change, will re-validate on submit
    if (error) {
      setError(null)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const trimmed = value.trim()
       // Hitting Enter on an empty name should behave like cancel rather than
       // showing a validation error. This matches the blur behavior and keeps
       // the inline UX lightweight.
       if (!trimmed) {
         onCancel()
         return
       }
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

  const handleConfirmMouseDown = (e: MouseEvent<HTMLButtonElement>) => {
    // Treat clicking the checkmark as an explicit "submit" action that mirrors
    // pressing Enter, but without relying on blur ordering.
    e.preventDefault()
    e.stopPropagation()

    const trimmed = value.trim()
    const validationError = validate(trimmed)
    if (validationError) {
      setError(validationError)
      return
    }
    onSubmit(trimmed)
  }

  const handleCancelMouseDown = (e: MouseEvent<HTMLButtonElement>) => {
    // Prevent the input from blurring first, which would otherwise trigger
    // blur handlers that might submit a rename. For both create and rename
    // flows, an explicit "X" click should be treated as a hard cancel.
    e.preventDefault()
    e.stopPropagation()
    onCancel()
  }

  const handleBlur = () => {
    const trimmed = value.trim()

    // Guard against transient blur immediately after we start an inline edit,
    // which can happen when menus close or when the user is still in the
    // mouse-down/mouse-up sequence from the action that opened the editor.
    // If the user hasn't typed yet and the blur happens very soon after mount,
    // re-focus the input instead of treating it as a real blur.
    if (!hasUserEdited && mountTimeRef.current !== null) {
      const elapsed = performance.now() - mountTimeRef.current
      if (elapsed < 200) {
        requestAnimationFrame(() => {
          if (inputRef.current) {
            inputRef.current.focus()
            inputRef.current.select()
          }
        })
        return
      }
    }

    // For create mode (new temp item), treat blur as a "soft" action:
    // - If user hasn't typed yet, ignore the first blur. This prevents
    //   context-menu focus races from immediately cancelling the edit.
    // - If name is empty after user edits -> cancel (do not create).
    // - If name is unchanged from the initial value after user edits
    //   (e.g., they typed then reverted) -> cancel.
    // - If user edited the name to a non-empty value -> submit if valid.
    if (mode === 'create') {
      if (!hasUserEdited) {
        // Ignore initial blur when the user hasn't interacted with the field.
        // The temp item remains visible and can still be edited or cancelled
        // explicitly with Escape.
        return
      }

      if (!trimmed) {
        onCancel()
        return
      }

      // Only auto-create on blur if user actually changed the name.
      if (trimmed === initialValue.trim()) {
        onCancel()
        return
      }

      const validationError = validate(trimmed)
      if (!validationError) {
        onSubmit(trimmed)
      } else {
        onCancel()
      }
      return
    }

    // Rename mode (existing items): submit if valid, cancel if empty/invalid.
    // This sidesteps focus race conditions from dropdown/context menus
    // and matches OS behavior (Finder, Explorer, VS Code).
    const validationError = validate(trimmed)
    if (trimmed && !validationError) {
      onSubmit(trimmed)
    } else {
      onCancel()
    }
  }

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1">
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
        <button
          type="button"
          onMouseDown={handleConfirmMouseDown}
          className={cn(
            'flex-shrink-0 rounded p-0.5',
            'text-muted-foreground hover:text-foreground',
            'opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity'
          )}
          aria-label="Confirm name"
        >
          <Check className="size-3" />
        </button>
        <button
          type="button"
          onMouseDown={handleCancelMouseDown}
          className={cn(
            'flex-shrink-0 rounded p-0.5',
            'text-muted-foreground hover:text-foreground',
            // Only show on hover/focus to keep UI minimal; relies on parent adding `group`.
            'opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity'
          )}
          aria-label="Cancel"
        >
          <X className="size-3" />
        </button>
      </div>
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
