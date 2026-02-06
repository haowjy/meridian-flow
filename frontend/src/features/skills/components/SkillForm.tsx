import { useRef, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Label } from '@/shared/components/ui/label'
import {
  EditorFormField,
  EditorFormInput,
  EditorFormTextarea,
} from '@/shared/components/ui/editor-form'
import { CodeMirrorEditor, type CodeMirrorEditorRef } from '@/core/editor/codemirror'
import { normalizeSkillName } from '../lib/skillValidation'

export interface SkillFormProps {
  // Inline header (replaces DocumentHeaderBar)
  headerLeading?: ReactNode
  headerTitle?: ReactNode
  headerTrailing?: ReactNode

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
  headerLeading,
  headerTitle,
  headerTrailing,
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
  const editorRef = useRef<CodeMirrorEditorRef>(null)

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
    <div className="px-3 pt-2 pb-4 flex flex-col h-full gap-2.5">
      {/* Inline header - min-h-8 matches button height to prevent layout shift */}
      {(headerLeading || headerTitle || headerTrailing) && (
        <div className="flex items-center gap-2 min-h-8">
          {headerLeading}
          <div className="min-w-0 flex-1 truncate">
            {headerTitle}
          </div>
          {/* Always render trailing container to prevent layout shift */}
          <div className="shrink-0">
            {headerTrailing}
          </div>
        </div>
      )}

      {/* Command Name - fixed height, outside resizable panels */}
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

      {/* Description - native resize with character counter */}
      <EditorFormField
        label="Description"
        htmlFor="skill-description"
        error={descriptionError}
      >
        <div className="relative">
          <EditorFormTextarea
            id="skill-description"
            value={description}
            onChange={(e) => onDescriptionChange(e.target.value)}
            placeholder="Brief description of this skill..."
            className="min-h-[80px] resize-y overflow-y-auto pb-6"
            state={descriptionError ? 'error' : 'default'}
            disabled={disabled}
          />
          <div
            className={cn(
              "absolute bottom-1.5 right-2 text-xs pointer-events-none",
              description.length > 280 ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {description.length}/280
          </div>
        </div>
      </EditorFormField>

      {/* Instructions - fills remaining space */}
      <div className="flex-1 min-h-0 flex flex-col space-y-1">
        <div className="flex items-baseline gap-1">
          <Label htmlFor="skill-content" variant="editorial">Instructions (Markdown)</Label>
          {/* Always render span to prevent vertical shift - invisible when no error */}
          <span className={cn("text-xs", contentError ? "text-destructive" : "invisible")}>
            {contentError || '\u00A0'}
          </span>
        </div>
        {/* Click-anywhere-to-write wrapper: clickBelowContentExtension handles clicks in empty area */}
        <div
          className={cn(
            "border rounded-md overflow-hidden flex-1 bg-card transition-all cursor-text",
            // Override CodeMirror's default height:auto to make it fill container and scroll
            // h-full on scroller ensures clickBelowContentExtension receives clicks below content
            "[&_.cm-editor]:!h-full [&_.cm-scroller]:!h-full [&_.cm-scroller]:!overflow-auto",
            contentError
              ? 'border-destructive'
              : 'border-editor-input-border hover:border-primary/30 focus-within:border-primary'
          )}
          style={{ boxShadow: 'var(--editor-inset-shadow)' }}
        >
          <CodeMirrorEditor
            ref={editorRef}
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
