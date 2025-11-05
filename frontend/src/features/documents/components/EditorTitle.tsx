'use client'

import { useState, useRef, useEffect } from 'react'
import { Pencil, Check, X } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { cn } from '@/lib/utils'

interface EditorTitleProps {
  title: string
  onRename: (newTitle: string) => Promise<void>
  readOnly?: boolean
}

/**
 * Editable document title with inline editing.
 *
 * Behavior:
 * - Shows title with edit icon on hover
 * - Click to enter edit mode
 * - Enter to save, Escape to cancel
 * - Calls onRename when saving
 */
export function EditorTitle({ title, onRename, readOnly = false }: EditorTitleProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(title)
  const [isSaving, setIsSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Update editValue when title prop changes (from external updates)
  useEffect(() => {
    if (!isEditing) {
      setEditValue(title)
    }
  }, [title, isEditing])

  // Focus input when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleEdit = () => {
    if (readOnly) return
    setIsEditing(true)
  }

  const handleCancel = () => {
    setEditValue(title)
    setIsEditing(false)
  }

  const handleSave = async () => {
    const trimmed = editValue.trim()

    // Don't save if empty or unchanged
    if (!trimmed || trimmed === title) {
      handleCancel()
      return
    }

    setIsSaving(true)
    try {
      await onRename(trimmed)
      setIsEditing(false)
    } catch (error) {
      console.error('[EditorTitle] Rename failed:', error)
      // Keep in edit mode on error so user can retry
    } finally {
      setIsSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    } else if (e.key === 'Escape') {
      handleCancel()
    }
  }

  if (isEditing) {
    return (
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isSaving}
          className="text-xl font-semibold"
          placeholder="Document title"
        />
        <Button
          size="icon"
          variant="ghost"
          onClick={handleSave}
          disabled={isSaving}
          className="h-8 w-8 flex-shrink-0"
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={handleCancel}
          disabled={isSaving}
          className="h-8 w-8 flex-shrink-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    )
  }

  return (
    <div className="group flex items-center gap-2 border-b px-4 py-3 hover:bg-accent/50 transition-colors">
      <h1 className="flex-1 text-xl font-semibold truncate">
        {title}
      </h1>
      {!readOnly && (
        <Button
          size="icon"
          variant="ghost"
          onClick={handleEdit}
          className="h-8 w-8 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
          aria-label="Rename document"
        >
          <Pencil className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}
