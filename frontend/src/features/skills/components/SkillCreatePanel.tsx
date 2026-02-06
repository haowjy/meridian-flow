import { useState, useCallback } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { getErrorMessage, AppError } from '@/core/lib/errors'
import { makeLogger } from '@/core/lib/logger'
import { Button } from '@/shared/components/ui/button'
import { useSkillStore } from '@/core/stores/useSkillStore'
import { useUIStore } from '@/core/stores/useUIStore'
import { DocumentTreeToggle } from '@/shared/components/layout'
import { normalizeSkillName, validateSkillName } from '../lib/skillValidation'
import { SkillForm } from './SkillForm'

const log = makeLogger('skill-create-panel')

interface SkillCreatePanelProps {
  projectId: string
  projectSlug: string
  // Mobile navigation: callback to navigate back to tree view
  onBackToTree?: () => void
}

/**
 * Skill creation panel with inline editor.
 * Uses shared SkillForm for form fields.
 * Creates skill via API, then navigates to editor.
 */
export function SkillCreatePanel({ projectId, projectSlug, onBackToTree }: SkillCreatePanelProps) {
  const navigate = useNavigate()
  const { createSkill } = useSkillStore()
  const documentTreeCollapsed = useUIStore((s) => s.documentTreeCollapsed)

  // Local form state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [content, setContent] = useState('')

  // Track which fields have been touched (for validation display)
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set())

  // Submission state
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [descriptionApiError, setDescriptionApiError] = useState<string | null>(null)

  // Derive validation state
  const nameValidation = validateSkillName(name)
  const isDescriptionEmpty = description.trim() === ''
  const isContentEmpty = content.trim() === ''

  // Form is valid if all required fields are filled and name is valid
  const canCreate =
    nameValidation.error === undefined &&
    !isDescriptionEmpty &&
    !isContentEmpty

  // Show validation errors only if field was touched and is invalid
  const descriptionError = touchedFields.has('description') && isDescriptionEmpty
    ? 'Description is required'
    : undefined
  const contentError = touchedFields.has('content') && isContentEmpty
    ? 'Instructions are required'
    : undefined

  // Handle field changes with touched tracking
  const handleNameChange = useCallback((value: string) => {
    setName(value)
    setNameError(null)  // Clear API error when user tries again
  }, [])

  const handleDescriptionChange = useCallback((value: string) => {
    setDescription(value)
    setTouchedFields((prev) => new Set(prev).add('description'))
    setDescriptionApiError(null)  // Clear API error when user tries again
  }, [])

  const handleContentChange = useCallback((value: string) => {
    setContent(value)
    setTouchedFields((prev) => new Set(prev).add('content'))
  }, [])

  // Handle create
  const handleCreate = useCallback(async () => {
    if (!canCreate) return

    setIsSubmitting(true)
    setNameError(null)
    setDescriptionApiError(null)

    try {
      const normalizedName = normalizeSkillName(name)
      const skill = await createSkill(projectId, {
        name: normalizedName,
        description: description.trim(),
        content: content.trim(),
      })

      // Navigate to the newly created skill's editor
      navigate({
        to: '/projects/$slug/skills/$skillName',
        params: { slug: projectSlug, skillName: skill.name },
        replace: true,  // Replace so back button doesn't return to /new
      })
    } catch (err) {
      const message = getErrorMessage(err)
      log.error('Failed to create skill:', message)

      // Route error to correct field based on backend ValidationError.Field
      const field = err instanceof AppError ? err.field : undefined
      if (field === 'description') {
        setDescriptionApiError(message)
      } else {
        // Default to name field for name errors or unknown errors
        setNameError(message)
      }
      setIsSubmitting(false)
    }
  }, [canCreate, name, description, content, projectId, createSkill, navigate, projectSlug])

  // Handle cancel - navigate back
  const handleCancel = useCallback(() => {
    // Navigate to project threads (default landing)
    navigate({
      to: '/projects/$slug/threads',
      params: { slug: projectSlug },
    })
  }, [navigate, projectSlug])

  // Combine mobile back button + document tree toggle for leading slot
  const mobileBackButton = onBackToTree ? (
    <Button
      variant="ghost"
      size="icon"
      onClick={onBackToTree}
      aria-label="Back to document tree"
      className="size-8"
    >
      <ChevronLeft className="size-5" />
    </Button>
  ) : null

  const leadingContent = (
    <>
      {mobileBackButton && <div className="md:hidden">{mobileBackButton}</div>}
      {documentTreeCollapsed && <div className="hidden md:block"><DocumentTreeToggle /></div>}
    </>
  )

  const hasLeadingContent = mobileBackButton || documentTreeCollapsed

  // Determine which validation error to show in header
  const headerValidationError = !canCreate
    ? (nameValidation.error ||
       (isDescriptionEmpty ? 'Description required' : 'Instructions required'))
    : undefined

  return (
    <div className="flex h-full flex-col bg-background overflow-hidden">
      <SkillForm
        headerLeading={hasLeadingContent ? leadingContent : undefined}
        headerTitle={
          <span className="text-sm font-medium text-muted-foreground">
            /new-skill
          </span>
        }
        headerTrailing={
          <div className="flex items-center gap-2">
            {/* Validation hint (only when fields are touched) */}
            {touchedFields.size > 0 && headerValidationError && (
              <span className="text-sm text-destructive">
                {headerValidationError}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!canCreate || isSubmitting}
            >
              {isSubmitting ? 'Creating...' : 'Create'}
            </Button>
          </div>
        }
        name={name}
        description={description}
        content={content}
        onNameChange={handleNameChange}
        onDescriptionChange={handleDescriptionChange}
        onContentChange={handleContentChange}
        nameError={nameValidation.error || nameError || undefined}
        descriptionError={descriptionError || descriptionApiError || undefined}
        contentError={contentError}
        showNameHint={true}
        disabled={isSubmitting}
      />
    </div>
  )
}
