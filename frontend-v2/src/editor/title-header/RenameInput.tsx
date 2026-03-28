import { useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

interface RenameInputProps {
  /** Current document name */
  name: string
  /** Called with the new name when the user confirms the rename */
  onRename: (newName: string) => void
  className?: string
}

/**
 * Click-to-rename inline input for the document title.
 *
 * Interaction:
 * 1. Click activates a text input, pre-filled with current name, text fully selected
 * 2. Enter confirms rename (calls onRename)
 * 3. Escape cancels rename
 * 4. Blur (click outside) cancels rename
 * 5. Empty input reverts to previous name
 */
export function RenameInput({ name, onRename, className }: RenameInputProps) {
  const [isEditing, setIsEditing] = useState(false)
  // Draft is initialized from name and reset to name on startEditing/cancel.
  // No need to sync draft with name during render -- the draft is only
  // visible while isEditing is true, and we always reset it on startEditing.
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  const startEditing = useCallback(() => {
    setDraft(name)
    setIsEditing(true)
  }, [name])

  const confirmRename = useCallback(() => {
    const trimmed = draft.trim()
    setIsEditing(false)
    if (trimmed && trimmed !== name) {
      onRename(trimmed)
    }
  }, [draft, name, onRename])

  const cancelRename = useCallback(() => {
    setIsEditing(false)
  }, [])

  // Focus and select all text when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            confirmRename()
          } else if (e.key === "Escape") {
            e.preventDefault()
            cancelRename()
          }
        }}
        onBlur={cancelRename}
        className={cn(
          "h-7 rounded-md border border-input bg-background px-2 text-sm font-semibold",
          "text-foreground outline-none",
          "focus-visible:border-foreground/30",
          className,
        )}
        aria-label="Rename document"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      className={cn(
        "h-7 rounded-md px-2 text-sm font-semibold text-foreground",
        "hover:bg-muted transition-colors cursor-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        className,
      )}
      title="Click to rename"
    >
      {name}
    </button>
  )
}
