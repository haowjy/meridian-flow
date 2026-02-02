import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/shared/components/ui/label'
import {
  EditorFormField,
  EditorFormInput,
  EditorFormTextarea,
} from '@/shared/components/ui/editor-form'
import { CodeMirrorEditor } from '@/core/editor/codemirror'
import { normalizeSkillName } from '../lib/skillValidation'

export interface SkillFormProps {
  // Form values
  name: string
  description: string
  content: string

  // Change handlers
  onNameChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onContentChange: (value: string) => void

  // Validation errors (shown when touched)
  nameError?: string
  descriptionError?: string
  contentError?: string

  // Display hints
  showNameHint?: boolean

  // Loading state (disables editing)
  disabled?: boolean
}

/**
 * Shared skill form component.
 * Pure presentation - no state management or API calls.
 * Used by both SkillEditorPanel (edit) and SkillCreatePanel (create).
 *
 * Form fields:
 * - Command Name: normalized input with "/" prefix
 * - Description: textarea for brief description
 * - Instructions: CodeMirror editor for markdown content
 */
export function SkillForm({
  name,
  description,
  content,
  onNameChange,
  onDescriptionChange,
  onContentChange,
  nameError,
  descriptionError,
  contentError,
  showNameHint = true,
  disabled = false,
}: SkillFormProps) {
  const nameInputRef = useRef<HTMLInputElement>(null)

  // Normalize name input immediately on keystroke with cursor position preservation
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    const cursorPos = input.selectionStart ?? 0
    const originalValue = input.value
    const normalized = normalizeSkillName(originalValue)

    // Calculate new cursor position:
    // Normalize the portion before cursor to find where cursor should land
    const charsBeforeCursor = originalValue.slice(0, cursorPos)
    const normalizedBeforeCursor = normalizeSkillName(charsBeforeCursor)
    const newCursorPos = normalizedBeforeCursor.length

    onNameChange(normalized)

    // Restore cursor position after React re-renders
    requestAnimationFrame(() => {
      if (nameInputRef.current) {
        nameInputRef.current.setSelectionRange(newCursorPos, newCursorPos)
      }
    })
  }

  return (
    <div className="max-w-4xl mx-auto px-4 pt-2.5 pb-4 flex flex-col h-full gap-2.5">
      {/* Command Name */}
      <EditorFormField
        label="Command Name"
        htmlFor="skill-name"
        hint={showNameHint ? 'letters, numbers, hyphens' : undefined}
        error={nameError}
        leading={<span className="text-base font-light text-muted-foreground">/</span>}
      >
        <EditorFormInput
          ref={nameInputRef}
          id="skill-name"
          value={name}
          onChange={handleNameChange}
          placeholder="command-name"
          className="flex-1"
          state={nameError ? 'error' : 'default'}
          disabled={disabled}
        />
      </EditorFormField>

      {/* Description */}
      <EditorFormField
        label="Description"
        htmlFor="skill-description"
        error={descriptionError}
      >
        <EditorFormTextarea
          id="skill-description"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Brief description of this skill..."
          className="min-h-[60px] max-h-[140px] overflow-y-auto"
          state={descriptionError ? 'error' : 'default'}
          disabled={disabled}
        />
      </EditorFormField>

      {/* Instructions - CodeMirror Editor fills remaining space */}
      <div className="flex-1 flex flex-col min-h-0 space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="skill-content" variant="editorial">Instructions (Markdown)</Label>
          {contentError && (
            <span className="text-xs text-destructive">{contentError}</span>
          )}
        </div>
        <div
          className={cn(
            "border rounded-md overflow-hidden flex-1 bg-card transition-all",
            contentError
              ? 'border-destructive'
              : 'border-editor-input-border hover:border-primary/30 focus-within:border-primary'
          )}
          style={{ boxShadow: 'var(--editor-inset-shadow)' }}
        >
          <CodeMirrorEditor
            initialContent={content}
            onChange={onContentChange}
            editable={!disabled}
            placeholder="Enter skill instructions..."
          />
        </div>
      </div>
    </div>
  )
}
