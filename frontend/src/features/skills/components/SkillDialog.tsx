import { useState, useEffect } from 'react'
import { AlertCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Switch } from '@/shared/components/ui/switch'
import { useSkillStore } from '@/core/stores/useSkillStore'
import { getErrorMessage } from '@/core/lib/errors'
import { cn } from '@/lib/utils'
import type { SkillWithContent } from '../types/skill'

interface SkillDialogProps {
  projectId: string
  /** If provided, dialog is in edit mode. Otherwise, create mode. */
  skill?: SkillWithContent | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Validates skill name format (URL-safe identifiers)
function validateSkillName(name: string): string | null {
  if (!name) return 'Name is required'
  const pattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
  if (!pattern.test(name)) {
    return 'Must be lowercase alphanumeric with hyphens (e.g., "writing-coach")'
  }
  if (name.length > 50) return 'Maximum 50 characters'
  return null
}

// Convert display name to URL-safe identifier
function toIdentifier(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Count words in text
function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

// Textarea styling matching Input component with fixed height for internal scroll
const textareaClasses = cn(
  // Base styles from Input
  'placeholder:text-muted-foreground bg-card border-input w-full min-w-0 rounded-sm border px-3 py-2 text-base transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-[--opacity-disabled] md:text-sm font-sans',
  // Focus ring
  'focus-visible:outline-[3px] focus-visible:outline-[var(--focus-ring-outer)] focus-visible:outline-offset-0 focus-visible:border-transparent focus-visible:shadow-[0_0_0_2px_var(--focus-ring-inner)]',
  // Fixed height with internal scroll (no dialog scroll)
  'resize-none h-[200px] overflow-y-auto'
)

export function SkillDialog({ projectId, skill, open, onOpenChange }: SkillDialogProps) {
  const createSkill = useSkillStore((s) => s.createSkill)
  const updateSkill = useSkillStore((s) => s.updateSkill)

  const isEditMode = Boolean(skill)

  // Single "name" input → used as displayName, auto-generates identifier
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')
  const [userInvocable, setUserInvocable] = useState(true)
  const [aiAutoInvocation, setAiAutoInvocation] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Derived: generate identifier from name
  const identifier = toIdentifier(name)

  // Populate form when skill changes (edit mode) or reset when opening create mode
  useEffect(() => {
    if (skill) {
      // Edit mode: populate from skill
      setName(skill.displayName)
      setDescription(skill.description)
      setContent(skill.content || '')
      setUserInvocable(skill.userInvocable)
      setAiAutoInvocation(!skill.disableModelInvocation)
      setError(null)
    } else if (open) {
      // Create mode: reset form
      resetForm()
    }
  }, [skill, open])

  const resetForm = () => {
    setName('')
    setDescription('')
    setContent('')
    setUserInvocable(true)
    setAiAutoInvocation(true)
    setError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!name.trim() || !description.trim()) {
      setError('Name and summary are required')
      return
    }

    const identifierError = validateSkillName(identifier)
    if (identifierError) {
      setError(identifierError)
      return
    }

    setIsSubmitting(true)
    try {
      if (isEditMode && skill) {
        await updateSkill(projectId, skill.id, {
          name: identifier,
          displayName: name.trim(),
          description: description.trim(),
          content: content.trim() || undefined,
          disableModelInvocation: !aiAutoInvocation,
          userInvocable,
        })
      } else {
        await createSkill(projectId, {
          name: identifier,
          displayName: name.trim(),
          description: description.trim(),
          content: content.trim() || undefined,
          disableModelInvocation: !aiAutoInvocation,
          userInvocable,
        })
      }

      onOpenChange(false)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleOpenChange = (newOpen: boolean) => {
    if (!isSubmitting) {
      onOpenChange(newOpen)
    }
  }

  const wordCount = countWords(content)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEditMode ? 'Edit Skill' : 'Create Skill'}</DialogTitle>
            <DialogDescription>
              {isEditMode
                ? "Update your AI assistant's configuration"
                : 'Define an AI assistant specialized for your writing'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Name field with inline command badge */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="name">Name</Label>
                <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-mono text-sm">
                  /{identifier || 'skill-name'}
                </span>
              </div>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Writing Coach"
                autoFocus={!isEditMode}
                disabled={isSubmitting}
              />
            </div>

            {/* Summary field */}
            <div className="space-y-2">
              <Label htmlFor="description">Summary</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Helps improve prose quality and style"
                disabled={isSubmitting}
              />
            </div>

            {/* Instructions textarea with internal scroll */}
            <div className="space-y-2">
              <Label htmlFor="content">Instructions</Label>
              <textarea
                id="content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Markdown instructions that define how the AI behaves when this skill is active..."
                className={textareaClasses}
                disabled={isSubmitting}
              />
              <p className="text-xs text-muted-foreground">Word count: {wordCount}</p>
            </div>

            {/* Inline toggles on same row */}
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <Switch
                  checked={userInvocable}
                  onCheckedChange={setUserInvocable}
                  disabled={isSubmitting}
                />
                <span className="text-sm text-muted-foreground">Slash command</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Switch
                  checked={aiAutoInvocation}
                  onCheckedChange={setAiAutoInvocation}
                  disabled={isSubmitting}
                />
                <span className="text-sm text-muted-foreground">AI auto-invocation</span>
              </label>
            </div>

            {/* Error Display */}
            {error && (
              <div className="flex items-center gap-2 py-2 px-3 rounded-md bg-destructive/10 text-destructive text-sm">
                <AlertCircle className="size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting || !identifier.trim() || !name.trim() || !description.trim()}
            >
              {isSubmitting
                ? isEditMode
                  ? 'Saving...'
                  : 'Creating...'
                : isEditMode
                  ? 'Save Changes'
                  : 'Create Skill'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
